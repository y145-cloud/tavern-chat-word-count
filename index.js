/**
 * 角色卡字数统计 — SillyTavern / TauriTavern 扩展
 *
 * 目标：
 *  - 对一张角色卡的所有聊天分别统计，再汇总；
 *  - 可按标签排除（默认排除思考/状态块）或只提取标签（例如只算 <content>）；
 *  - 千楼聊天不一次性渲染，楼层列表分页展示；
 *  - 只读聊天文件，绝不修改聊天内容，也不依赖/修改“楼层正文计数器”脚本。
 */

import {
    DEFAULT_SETTINGS,
    analyzeMessage,
    cloneDefaultSettings,
    formatCount,
    normalizeMessages,
    parseTagList,
    sanitizeSettings,
    settingsKey,
    stripJsonlExtension,
} from './core.js';

const EXTENSION_ID = 'chat-word-count';
const WAND_ID = 'ccwc-wand-item';
const OVERLAY_ID = 'ccwc-overlay';
const SETTINGS_KEY = 'ccwc:settings:v1';
const UNIT_KEY = 'ccwc:unit:v1';
const CACHE_PREFIX = 'ccwc:cache:v1:';
const CHUNK_SIZE = 40;
const DEFAULT_PAGE_SIZE = 100;

const state = {
    overlay: null,
    character: null,
    avatar: '',
    currentId: '',
    chats: [],
    results: new Map(),
    scanning: false,
    scanId: 0,
    abort: null,
    progress: null,
    selectedId: '',
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    settings: loadSettings(),
    unit: loadUnit(),
    cache: {},
    listError: null,
    fatalError: '',
    dirty: false,
    bus: null,
    debounceTimer: null,
    keyHandler: null,
    wandTimer: null,
};

init();

function init() {
    if (installWandEntry()) return;
    let attempts = 0;
    state.wandTimer = setInterval(() => {
        attempts += 1;
        if (installWandEntry() || attempts >= 120) {
            clearInterval(state.wandTimer);
            state.wandTimer = null;
        }
    }, 500);
}

function installWandEntry() {
    if (document.getElementById(WAND_ID)) return true;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;

    const wrapper = document.createElement('div');
    wrapper.className = 'extension_container';
    wrapper.id = 'ccwc-wand-container';
    wrapper.innerHTML = `
        <div id="${WAND_ID}" class="list-group-item flex-container flexGap5" role="button" tabindex="0">
            <div class="fa-solid fa-calculator extensionsMenuExtensionButton"></div>
            <span>角色卡字数统计</span>
        </div>`;
    menu.append(wrapper);

    const item = wrapper.querySelector(`#${WAND_ID}`);
    item.addEventListener('click', openPanel);
    item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPanel();
        }
    });
    return true;
}

function getContext() {
    const context = window.SillyTavern?.getContext?.() ?? window.getContext?.();
    if (!context) throw new Error('无法获取 SillyTavern 上下文。');
    return context;
}

function resolveCurrentCharacter() {
    const context = getContext();
    if (context.groupId) {
        const group = Array.isArray(context.groups)
            ? context.groups.find(candidate => String(candidate?.id) === String(context.groupId))
            : null;
        return { group: true, name: group?.name || '当前群聊', avatar: '' };
    }

    const characters = Array.isArray(context.characters) ? context.characters : [];
    let index = context.characterId;
    if (typeof index === 'string' && /^\d+$/.test(index)) index = Number(index);

    let character = Number.isInteger(index) && index >= 0 ? characters[index] : null;
    if (!character) character = characters.find(candidate => candidate?.avatar === index) || null;
    if (!character && context.name2) {
        character = characters.find(candidate => candidate?.name === context.name2) || null;
    }
    if (!character) return null;
    return { ...character, avatar: character.avatar || `${character.name}.png` };
}

function getCurrentChatId() {
    try {
        const context = getContext();
        const raw = context.chatId ?? context.getCurrentChatId?.() ?? '';
        return stripJsonlExtension(raw);
    } catch {
        return '';
    }
}

async function postJson(path, body) {
    const context = getContext();
    const headers = { 'Content-Type': 'application/json' };
    try {
        const extra = context.getRequestHeaders?.();
        if (extra && typeof extra.forEach === 'function' && typeof extra.get === 'function') {
            extra.forEach((value, key) => {
                headers[key] = value;
            });
        } else if (extra && typeof extra === 'object') {
            Object.assign(headers, extra);
        }
    } catch {
        // 某些环境没有 CSRF 需求；拿不到额外头时仍尝试请求。
    }

    const response = await fetch(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
    });
    const text = (await response.text()).replace(/^\uFEFF/, '');
    if (!response.ok) {
        const detail = text ? `：${text.slice(0, 160)}` : '';
        throw new Error(`HTTP ${response.status}${detail}`);
    }
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('服务器返回了无法解析的数据。');
    }
}

async function fetchChatList(avatar) {
    const payload = await postJson('/api/characters/chats', { avatar_url: avatar });
    if (payload && !Array.isArray(payload) && payload.error) {
        throw new Error(payload.message || '无法读取该角色的聊天目录。');
    }
    if (!Array.isArray(payload)) throw new Error('聊天列表的返回格式异常。');

    return payload
        .map(item => {
            const rawName = String(item.file_name ?? '');
            const rawId = String(item.file_id || '').trim();
            const id = stripJsonlExtension(rawId) || stripJsonlExtension(rawName);
            if (!id) return null;
            const count = Number(item.chat_items ?? item.mes ?? item.message_count ?? 0);
            return {
                id,
                fileName: rawName || `${id}.jsonl`,
                items: Number.isFinite(count) ? count : 0,
                size: item.file_size ?? '',
                lastMes: item.last_mes ?? '',
                isCurrent: id === state.currentId,
            };
        })
        .filter(Boolean)
        .sort(compareChats);
}

function compareChats(left, right) {
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
    const leftTime = toTimestamp(left.lastMes);
    const rightTime = toTimestamp(right.lastMes);
    if (leftTime !== rightTime) return rightTime - leftTime;
    return String(left.id).localeCompare(String(right.id), 'zh-CN');
}

function toTimestamp(value) {
    if (!value) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? 0 : parsed;
}

function mergeCurrentChat(source) {
    const chats = Array.isArray(source) ? [...source] : [];
    const currentId = state.currentId;
    let found = false;
    for (const chat of chats) {
        chat.isCurrent = Boolean(currentId) && chat.id === currentId;
        if (chat.isCurrent) found = true;
    }
    if (currentId && !found) {
        chats.unshift({
            id: currentId,
            fileName: `${currentId}.jsonl`,
            items: 0,
            size: '',
            lastMes: '',
            isCurrent: true,
        });
    }
    return chats.sort(compareChats);
}

async function ensureChatList(force) {
    if (!state.character) return;
    if (!force && state.chats.length > 0) {
        state.chats = mergeCurrentChat(state.chats);
        return;
    }

    try {
        const list = await fetchChatList(state.character.avatar);
        state.chats = mergeCurrentChat(list);
        state.listError = null;
    } catch (error) {
        state.listError = error instanceof Error ? error : new Error(String(error));
        state.chats = mergeCurrentChat(state.chats);
    }
}

async function fetchChatMessages(chat) {
    const payload = await postJson('/api/chats/get', {
        avatar_url: state.character.avatar,
        ch_name: state.character.name,
        file_name: chat.id,
    });
    if (!Array.isArray(payload)) throw new Error('聊天内容的返回格式异常。');
    return normalizeMessages(payload);
}

function getLiveMessages() {
    try {
        const live = getContext().chat;
        if (!Array.isArray(live)) return null;
        if (live.some(message => message === null)) return null;
        return live;
    } catch {
        return null;
    }
}

async function analyzeChat(chat, options) {
    const { signal, onFloors } = options;
    let messages = null;

    if (chat.id === state.currentId) {
        const live = getLiveMessages();
        if (live && (live.length > 0 || !(Number(chat.items) > 0))) messages = live;
    }
    if (!messages) messages = await fetchChatMessages(chat);
    if (signal?.aborted) throw createAbortError();

    const total = messages.length;
    const floors = new Array(total);
    let totalUnits = 0;
    let totalChars = 0;

    for (let index = 0; index < total; index += 1) {
        if (signal?.aborted) throw createAbortError();
        const analysis = analyzeMessage(messages[index]?.mes ?? '', state.settings);
        floors[index] = [analysis.units, analysis.chars];
        totalUnits += analysis.units;
        totalChars += analysis.chars;

        if ((index + 1) % CHUNK_SIZE === 0 || index === total - 1) {
            onFloors?.(index + 1, total);
            await yieldToUi();
        }
    }

    return { floors, totalUnits, totalChars, items: total };
}

function createAbortError() {
    const error = new Error('已取消统计。');
    error.name = 'AbortError';
    return error;
}

function yieldToUi() {
    return new Promise(resolve => {
        setTimeout(resolve, 0);
    });
}

function chatSignature(chat) {
    return [chat.size ?? '', chat.lastMes ?? '', chat.items ?? ''].join('|');
}

function loadCache(avatar) {
    try {
        const raw = localStorage.getItem(CACHE_PREFIX + encodeURIComponent(avatar));
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function persistCache() {
    if (!state.avatar) return;
    try {
        localStorage.setItem(
            CACHE_PREFIX + encodeURIComponent(state.avatar),
            JSON.stringify(state.cache),
        );
    } catch {
        // 缓存是可选的；配额满/隐私模式失败时不影响统计。
    }
}

function getCached(chat) {
    const bucket = state.cache[settingsKey(state.settings)];
    const entry = bucket?.[chat.id];
    if (!entry || entry.sig !== chatSignature(chat) || !Array.isArray(entry.floors)) return null;
    return {
        floors: entry.floors,
        totalUnits: Number(entry.totalUnits) || 0,
        totalChars: Number(entry.totalChars) || 0,
        items: entry.floors.length,
        fromCache: true,
    };
}

function putCache(chat, result) {
    const key = settingsKey(state.settings);
    if (!state.cache[key]) state.cache[key] = {};
    state.cache[key][chat.id] = {
        sig: chatSignature(chat),
        floors: result.floors,
        totalUnits: result.totalUnits,
        totalChars: result.totalChars,
    };
    persistCache();
}

async function runScan(force) {
    if (!state.overlay) return;
    if (!state.character || state.character.group) {
        state.scanning = false;
        renderAll();
        return;
    }

    const runId = ++state.scanId;
    state.abort?.abort();
    const controller = new AbortController();
    state.abort = controller;
    state.scanning = true;
    state.results.clear();
    state.listError = null;
    state.progress = { done: 0, total: 1, chatName: '', floorsDone: 0, floorsTotal: 0 };
    renderAll();

    try {
        await ensureChatList(Boolean(force));
        if (runId !== state.scanId) return;

        if (!state.selectedId || !state.chats.some(chat => chat.id === state.selectedId)) {
            state.selectedId = state.currentId || state.chats[0]?.id || '';
        }

        state.progress.total = Math.max(1, state.chats.length);
        renderAll();

        for (let index = 0; index < state.chats.length; index += 1) {
            if (controller.signal.aborted) throw createAbortError();
            if (runId !== state.scanId) return;

            const chat = state.chats[index];
            state.progress.chatName = chat.id;
            state.progress.floorsDone = 0;
            state.progress.floorsTotal = Number(chat.items) || 0;
            renderProgress();

            let result = null;
            if (!force && !chat.isCurrent) result = getCached(chat);

            if (!result) {
                try {
                    result = await analyzeChat(chat, {
                        force,
                        signal: controller.signal,
                        onFloors: (done, total) => {
                            if (runId !== state.scanId) return;
                            state.progress.floorsDone = done;
                            state.progress.floorsTotal = total;
                            renderProgress();
                        },
                    });
                } catch (error) {
                    if (error?.name === 'AbortError') throw error;
                    result = {
                        floors: [],
                        totalUnits: 0,
                        totalChars: 0,
                        items: 0,
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            }

            if (runId !== state.scanId) return;
            state.results.set(chat.id, { ...chat, ...result });
            if (!result.error && !chat.isCurrent) putCache(chat, result);
            state.progress.done = index + 1;
            renderAll();
        }
    } catch (error) {
        if (error?.name !== 'AbortError') {
            state.listError = error instanceof Error ? error : new Error(String(error));
        }
    } finally {
        if (runId === state.scanId) {
            state.scanning = false;
            state.abort = null;
            state.progress = null;
            renderAll();
        }
    }
}

function openPanel() {
    if (state.overlay) {
        closePanel();
        return;
    }

    state.fatalError = '';
    state.listError = null;
    state.progress = null;
    state.scanning = false;
    state.results.clear();
    state.selectedId = '';
    state.page = 1;
    state.dirty = false;
    state.settings = loadSettings();
    state.unit = loadUnit();
    state.currentId = getCurrentChatId();

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'ccwc-overlay';
    overlay.innerHTML = buildPanelHtml();
    document.body.append(overlay);
    document.body.classList.add('ccwc-open');
    state.overlay = overlay;

    syncControls();
    updateHint();
    bindPanelEvents();

    let character = null;
    try {
        character = resolveCurrentCharacter();
    } catch (error) {
        state.fatalError = error instanceof Error ? error.message : String(error);
    }

    if (!character) {
        state.fatalError = state.fatalError || '没有选中角色卡。请先在酒馆里选择一张角色卡，再打开统计。';
        state.character = null;
        renderAll();
        return;
    }

    if (character.group) {
        state.character = character;
        state.fatalError = '群聊暂不支持：群聊的聊天文件属于多个角色，字数归属会混淆。请打开单张角色卡后统计。';
        renderAll();
        return;
    }

    const changedCharacter = Boolean(state.avatar) && state.avatar !== character.avatar;
    state.character = character;
    state.avatar = character.avatar;
    if (changedCharacter) {
        state.chats = [];
        state.selectedId = '';
        state.page = 1;
    }
    state.selectedId = state.selectedId || state.currentId;
    state.cache = loadCache(state.avatar);
    renderAll();
    subscribeEvents();
    runScan(false);
}

function closePanel() {
    if (!state.overlay) return;
    state.scanId += 1;
    state.abort?.abort();
    state.abort = null;
    state.scanning = false;
    state.progress = null;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;

    unsubscribeEvents();
    if (state.keyHandler) {
        document.removeEventListener('keydown', state.keyHandler);
        state.keyHandler = null;
    }

    state.overlay.remove();
    state.overlay = null;
    state.chats = [];
    state.results.clear();
    state.selectedId = '';
    document.body.classList.remove('ccwc-open');
}

function buildPanelHtml() {
    return `
        <div class="ccwc-modal" role="dialog" aria-modal="true" aria-labelledby="ccwc-title">
            <header class="ccwc-header">
                <div class="ccwc-head-main">
                    <div id="ccwc-avatar" class="ccwc-avatar" hidden></div>
                    <div class="ccwc-head-text">
                        <h2 id="ccwc-title">角色卡字数统计</h2>
                        <div id="ccwc-subtitle" class="ccwc-subtitle">正在准备…</div>
                    </div>
                </div>
                <button id="ccwc-close" class="ccwc-icon-button" type="button" aria-label="关闭">×</button>
            </header>

            <section class="ccwc-controls">
                <div class="ccwc-control-row">
                    <span class="ccwc-label">统计范围</span>
                    <label class="ccwc-radio">
                        <input type="radio" name="ccwc-mode" value="exclude" aria-label="排除标签">
                        <span>排除标签</span>
                    </label>
                    <label class="ccwc-radio">
                        <input type="radio" name="ccwc-mode" value="extract" aria-label="只取标签">
                        <span>只取标签</span>
                    </label>
                    <span class="ccwc-spacer"></span>
                    <label class="ccwc-inline" for="ccwc-unit">单位</label>
                    <select id="ccwc-unit" class="ccwc-select">
                        <option value="units">字数（中日韩按字，其他按词）</option>
                        <option value="chars">字符数（去空白，含标点）</option>
                    </select>
                </div>

                <div class="ccwc-control-row ccwc-tags-row">
                    <label class="ccwc-label" for="ccwc-tags">标签</label>
                    <textarea id="ccwc-tags" class="ccwc-textarea" rows="2"
                        placeholder="例如：content 或 think, details；支持 &lt;tag&gt; 写法"></textarea>
                    <div id="ccwc-hint" class="ccwc-hint"></div>
                </div>

                <div class="ccwc-control-row">
                    <span class="ccwc-label">快捷规则</span>
                    <button type="button" class="ccwc-chip" data-preset="default">默认（排除思考/状态）</button>
                    <button type="button" class="ccwc-chip" data-preset="content">只看 &lt;content&gt;</button>
                    <span class="ccwc-spacer"></span>
                    <button id="ccwc-apply" type="button" class="ccwc-button ccwc-primary">应用并统计</button>
                    <button id="ccwc-refresh" type="button" class="ccwc-button">刷新</button>
                </div>
            </section>

            <div id="ccwc-progress" class="ccwc-progress" hidden>
                <div class="ccwc-progress-top">
                    <span id="ccwc-progress-text">准备中…</span>
                    <button id="ccwc-cancel" type="button" class="ccwc-link-button">取消</button>
                </div>
                <div class="ccwc-progress-track">
                    <div id="ccwc-progress-bar" class="ccwc-progress-bar"></div>
                </div>
            </div>

            <main class="ccwc-body">
                <div id="ccwc-error" class="ccwc-alert" hidden>
                    <span id="ccwc-error-text"></span>
                    <button id="ccwc-retry" type="button" class="ccwc-link-button">重试</button>
                </div>
                <section id="ccwc-summary" class="ccwc-summary"></section>
                <section class="ccwc-section">
                    <div class="ccwc-section-head">
                        <h3>聊天列表</h3>
                        <span id="ccwc-chat-count" class="ccwc-muted"></span>
                    </div>
                    <div class="ccwc-table-wrap">
                        <table class="ccwc-table">
                            <thead>
                                <tr>
                                    <th>聊天</th>
                                    <th class="ccwc-num">楼层</th>
                                    <th class="ccwc-num">字数</th>
                                    <th class="ccwc-num">字符</th>
                                    <th>最后消息</th>
                                </tr>
                            </thead>
                            <tbody id="ccwc-table-body"></tbody>
                        </table>
                    </div>
                </section>
                <section id="ccwc-detail" class="ccwc-detail"></section>
            </main>

            <footer class="ccwc-footer">
                <span>只读统计，不会修改聊天。计数口径与“楼层正文计数器”一致：代码块、图片、链接地址、HTML 标签与宏不计入。</span>
                <button id="ccwc-export" type="button" class="ccwc-button">导出 CSV</button>
            </footer>
        </div>`;
}

function bindPanelEvents() {
    const overlay = state.overlay;
    if (!overlay) return;

    overlay.querySelector('#ccwc-close')?.addEventListener('click', closePanel);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closePanel();
    });

    overlay.querySelector('#ccwc-apply')?.addEventListener('click', applySettings);
    overlay.querySelector('#ccwc-refresh')?.addEventListener('click', () => runScan(true));
    overlay.querySelector('#ccwc-cancel')?.addEventListener('click', cancelScan);
    overlay.querySelector('#ccwc-retry')?.addEventListener('click', () => {
        state.listError = null;
        runScan(true);
    });
    overlay.querySelector('#ccwc-export')?.addEventListener('click', exportCsv);

    overlay.querySelectorAll('input[name="ccwc-mode"]').forEach(input => {
        input.addEventListener('change', () => {
            state.dirty = true;
            updateHint();
        });
    });
    overlay.querySelector('#ccwc-tags')?.addEventListener('input', () => {
        state.dirty = true;
        updateHint();
    });
    overlay.querySelector('#ccwc-unit')?.addEventListener('change', event => {
        state.unit = event.target.value === 'chars' ? 'chars' : 'units';
        try {
            localStorage.setItem(UNIT_KEY, state.unit);
        } catch {
            // 忽略隐私模式下的存储失败。
        }
        renderAll();
    });

    overlay.querySelectorAll('[data-preset]').forEach(button => {
        button.addEventListener('click', () => applyPreset(button.dataset.preset));
    });

    overlay.querySelector('#ccwc-table-body')?.addEventListener('click', event => {
        const row = event.target.closest?.('tr[data-chat-id]');
        if (!row) return;
        selectChat(row.dataset.chatId);
    });
    overlay.querySelector('#ccwc-table-body')?.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest?.('tr[data-chat-id]');
        if (!row) return;
        event.preventDefault();
        selectChat(row.dataset.chatId);
    });

    overlay.querySelector('#ccwc-detail')?.addEventListener('click', handleDetailClick);
    overlay.querySelector('#ccwc-detail')?.addEventListener('change', event => {
        if (event.target.id !== 'ccwc-page-size') return;
        const size = Number(event.target.value);
        state.pageSize = Number.isFinite(size) && size > 0 ? size : DEFAULT_PAGE_SIZE;
        state.page = 1;
        renderDetail();
    });
    overlay.querySelector('#ccwc-detail')?.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target.id === 'ccwc-jump') {
            event.preventDefault();
            jumpToPage();
        }
    });

    state.keyHandler = event => {
        if (event.key === 'Escape' && state.overlay) closePanel();
    };
    document.addEventListener('keydown', state.keyHandler);
}

function applyPreset(name) {
    const overlay = state.overlay;
    if (!overlay) return;
    const mode = name === 'content' ? 'extract' : 'exclude';
    const tags = name === 'content' ? 'content' : DEFAULT_SETTINGS.tags.join('\n');
    overlay.querySelectorAll('input[name="ccwc-mode"]').forEach(input => {
        input.checked = input.value === mode;
    });
    const textarea = overlay.querySelector('#ccwc-tags');
    if (textarea) textarea.value = tags;
    state.dirty = true;
    updateHint();
    applySettings();
}

function readSettingsFromControls() {
    const mode = state.overlay?.querySelector('input[name="ccwc-mode"]:checked')?.value;
    const tags = state.overlay?.querySelector('#ccwc-tags')?.value ?? '';
    return sanitizeSettings({ mode, tags });
}

function applySettings() {
    const parsed = readSettingsFromControls();
    if (parsed.mode === 'extract' && parsed.tags.length === 0) {
        notify('warning', '“只取标签”模式至少要填写一个标签，例如 content。');
        return;
    }
    state.settings = parsed;
    saveSettings(parsed);
    state.dirty = false;
    state.page = 1;
    updateHint();
    runScan(false);
}

function updateHint() {
    const hint = state.overlay?.querySelector('#ccwc-hint');
    if (!hint) return;
    const parsed = readSettingsFromControls();
    let text;
    if (parsed.mode === 'extract') {
        text = parsed.tags.length
            ? `只统计这些标签内的文字：${parsed.tags.join('、')}`
            : '只统计标签内的文字；请填写标签，例如 content。';
    } else {
        text = parsed.tags.length
            ? `排除这些标签：${parsed.tags.join('、')}`
            : '当前不排除任何标签，整层文字都会计入。';
    }
    hint.textContent = state.dirty ? `${text}（尚未应用）` : text;
}

function syncControls() {
    const overlay = state.overlay;
    if (!overlay) return;
    overlay.querySelectorAll('input[name="ccwc-mode"]').forEach(input => {
        input.checked = input.value === state.settings.mode;
    });
    const textarea = overlay.querySelector('#ccwc-tags');
    if (textarea) textarea.value = state.settings.tags.join('\n');
    const unit = overlay.querySelector('#ccwc-unit');
    if (unit) unit.value = state.unit;
}

function selectChat(chatId) {
    state.selectedId = chatId;
    state.page = 1;
    renderTable();
    renderDetail();
}

function cancelScan() {
    if (!state.scanning) return;
    state.scanId += 1;
    state.abort?.abort();
    state.abort = null;
    state.scanning = false;
    state.progress = null;
    renderAll();
    notify('info', '已取消本次统计。');
}

async function refreshCharacter() {
    if (!state.overlay) return;
    let character = null;
    try {
        character = resolveCurrentCharacter();
    } catch (error) {
        state.fatalError = error instanceof Error ? error.message : String(error);
        renderAll();
        return;
    }
    if (!character) {
        state.character = null;
        state.fatalError = '没有选中角色卡。请先在酒馆里选择一张角色卡。';
        renderAll();
        return;
    }
    if (character.group) {
        state.character = character;
        state.fatalError = '群聊暂不支持：群聊的聊天文件属于多个角色，字数归属会混淆。';
        renderAll();
        return;
    }

    const changedCharacter = Boolean(state.avatar) && state.avatar !== character.avatar;
    const previousCurrent = state.currentId;
    state.fatalError = '';
    state.character = character;
    state.avatar = character.avatar;
    state.currentId = getCurrentChatId();
    if (changedCharacter) {
        state.chats = [];
        state.results.clear();
        state.selectedId = '';
        state.page = 1;
        state.cache = loadCache(state.avatar);
    } else if (previousCurrent !== state.currentId) {
        state.selectedId = state.currentId;
        state.page = 1;
    }
    if (!state.selectedId) state.selectedId = state.currentId;
    renderAll();
    await runScan(false);
}

function scheduleRescan() {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
        refreshCharacter();
    }, 650);
}

function subscribeEvents() {
    unsubscribeEvents();
    let context;
    try {
        context = getContext();
    } catch {
        return;
    }
    const source = context.eventSource;
    if (!source || typeof source.on !== 'function') return;
    const types = context.eventTypes ?? {};
    const chatEvent = types.CHAT_CHANGED || 'chat_id_changed';
    const characterEvent = types.CHARACTER_EDITED || 'character_edited';
    const handler = () => scheduleRescan();
    const handlers = [];

    for (const eventName of [chatEvent, characterEvent]) {
        try {
            source.on(eventName, handler);
            handlers.push([eventName, handler]);
        } catch {
            // 某些宿主只提供部分事件，忽略即可。
        }
    }
    state.bus = { source, handlers };
}

function unsubscribeEvents() {
    const bus = state.bus;
    state.bus = null;
    if (!bus) return;
    for (const [eventName, handler] of bus.handlers) {
        try {
            if (typeof bus.source.removeListener === 'function') {
                bus.source.removeListener(eventName, handler);
            } else if (typeof bus.source.off === 'function') {
                bus.source.off(eventName, handler);
            }
        } catch {
            // 忽略卸载失败，页面关闭后监听器自然失效。
        }
    }
}

function renderAll() {
    if (!state.overlay) return;
    renderHeader();
    renderError();
    renderSummary();
    renderTable();
    renderDetail();
    renderProgress();
}

function renderHeader() {
    const overlay = state.overlay;
    if (!overlay) return;
    const avatarBox = overlay.querySelector('#ccwc-avatar');
    const subtitle = overlay.querySelector('#ccwc-subtitle');
    const title = overlay.querySelector('#ccwc-title');
    if (!avatarBox || !subtitle || !title) return;

    if (state.character && !state.character.group && state.character.avatar) {
        avatarBox.hidden = false;
        avatarBox.innerHTML = `<img src="/thumbnail?type=avatar&file=${encodeURIComponent(state.character.avatar)}"
            alt="" referrerpolicy="no-referrer">`;
        avatarBox.querySelector('img')?.addEventListener('error', event => {
            event.currentTarget.style.display = 'none';
        });
    } else {
        avatarBox.hidden = true;
        avatarBox.textContent = '';
    }

    if (state.character?.group) {
        title.textContent = '角色卡字数统计';
        subtitle.textContent = `${state.character.name} · 群聊暂不支持`;
        return;
    }
    if (!state.character) {
        title.textContent = '角色卡字数统计';
        subtitle.textContent = '未选择角色卡';
        return;
    }

    const chatCount = state.chats.length;
    const parts = [state.character.name];
    parts.push(chatCount ? `${chatCount} 个聊天` : '正在读取聊天列表');
    if (state.currentId) parts.push(`当前：${state.currentId}`);
    title.textContent = '角色卡字数统计';
    subtitle.textContent = parts.join(' · ');
    subtitle.title = subtitle.textContent;
}

function renderError() {
    const overlay = state.overlay;
    if (!overlay) return;
    const banner = overlay.querySelector('#ccwc-error');
    const text = overlay.querySelector('#ccwc-error-text');
    if (!banner || !text) return;

    const message = state.fatalError
        || (state.listError ? `读取聊天列表失败：${state.listError.message}` : '');
    banner.hidden = !message;
    text.textContent = message;
}

function renderSummary() {
    const container = state.overlay?.querySelector('#ccwc-summary');
    if (!container) return;

    const results = [...state.results.values()].filter(result => !result.error);
    const totalUnits = results.reduce((sum, result) => sum + (Number(result.totalUnits) || 0), 0);
    const totalChars = results.reduce((sum, result) => sum + (Number(result.totalChars) || 0), 0);
    const totalFloors = results.reduce((sum, result) => sum + (result.floors?.length ?? 0), 0);
    const primary = state.unit === 'chars' ? totalChars : totalUnits;
    const primarySuffix = state.unit === 'chars' ? '字符' : '字';

    container.innerHTML = `
        <article class="ccwc-card ccwc-card-primary">
            <div class="ccwc-card-label">${state.unit === 'chars' ? '总字符' : '总字数'}</div>
            <div class="ccwc-card-value">${formatNumber(primary)}<span>${primarySuffix}</span></div>
            <div class="ccwc-card-note">${state.unit === 'chars' ? '已去掉空白，含标点' : '汉字按字，其他语言按词'}</div>
        </article>
        <article class="ccwc-card">
            <div class="ccwc-card-label">${state.unit === 'chars' ? '总字数' : '总字符'}</div>
            <div class="ccwc-card-value">${state.unit === 'chars'
                ? `${formatNumber(totalUnits)}<span>字</span>`
                : `${formatNumber(totalChars)}<span>字符</span>`}</div>
            <div class="ccwc-card-note">${state.unit === 'chars' ? '汉字按字，其他语言按词' : '同样规则下，去掉空白'}</div>
        </article>
        <article class="ccwc-card">
            <div class="ccwc-card-label">已统计聊天</div>
            <div class="ccwc-card-value">${formatNumber(results.length)}<span>/ ${formatNumber(state.chats.length)}</span></div>
            <div class="ccwc-card-note">${state.scanning ? '统计中，数字会实时增长' : '点击下方聊天查看楼层'}</div>
        </article>
        <article class="ccwc-card">
            <div class="ccwc-card-label">总楼层</div>
            <div class="ccwc-card-value">${formatNumber(totalFloors)}<span>楼</span></div>
            <div class="ccwc-card-note">当前规则下可统计的楼层</div>
        </article>`;

    const count = state.overlay?.querySelector('#ccwc-chat-count');
    if (count) count.textContent = `${state.chats.length} 个聊天`;
}

function renderTable() {
    const tbody = state.overlay?.querySelector('#ccwc-table-body');
    if (!tbody) return;

    if (state.chats.length === 0) {
        const message = state.fatalError
            ? '没有可统计的聊天。'
            : (state.scanning ? '正在读取聊天列表…' : '没有找到聊天记录。');
        tbody.innerHTML = `<tr><td colspan="5" class="ccwc-empty">${escapeHtml(message)}</td></tr>`;
        return;
    }

    tbody.innerHTML = state.chats.map(chat => {
        const result = state.results.get(chat.id);
        const units = result?.totalUnits;
        const value = result?.error
            ? '读取失败'
            : (result ? formatNumber(units) : (state.scanning ? '统计中…' : '—'));
        const chars = result?.error ? '—' : (result ? formatNumber(result.totalChars) : '—');
        const floors = result?.error ? '—' : (result ? (result.floors?.length ?? 0) : (chat.items || '—'));
        const classes = ['ccwc-chat-row'];
        if (chat.id === state.selectedId) classes.push('is-selected');
        if (chat.isCurrent) classes.push('is-current');
        const title = result?.error ? ` title="${escapeHtml(result.error)}"` : '';
        return `
            <tr class="${classes.join(' ')}" data-chat-id="${escapeHtml(chat.id)}" tabindex="0"${title}>
                <td class="ccwc-chat-name">
                    <span class="ccwc-chat-title">${escapeHtml(chat.id)}</span>
                    ${chat.isCurrent ? '<span class="ccwc-tag">当前</span>' : ''}
                </td>
                <td class="ccwc-num">${formatNumber(floors)}</td>
                <td class="ccwc-num">${value}</td>
                <td class="ccwc-num">${chars}</td>
                <td class="ccwc-muted">${escapeHtml(formatDate(chat.lastMes))}</td>
            </tr>`;
    }).join('');
}

function renderDetail() {
    const container = state.overlay?.querySelector('#ccwc-detail');
    if (!container) return;

    const chat = state.chats.find(item => item.id === state.selectedId)
        || state.results.get(state.selectedId);
    if (!chat) {
        container.innerHTML = '<div class="ccwc-empty ccwc-detail-empty">点击上方某个聊天，查看每一层的字数。</div>';
        return;
    }

    const result = state.results.get(chat.id);
    if (!result) {
        const message = state.scanning ? '正在统计这个聊天…' : '尚未统计。点击“应用并统计”。';
        container.innerHTML = `<div class="ccwc-detail-head"><h3>${escapeHtml(chat.id)}</h3></div>
            <div class="ccwc-empty ccwc-detail-empty">${escapeHtml(message)}</div>`;
        return;
    }
    if (result.error) {
        container.innerHTML = `<div class="ccwc-detail-head"><h3>${escapeHtml(chat.id)}</h3></div>
            <div class="ccwc-empty ccwc-detail-empty">读取失败：${escapeHtml(result.error)}</div>`;
        return;
    }

    const floors = Array.isArray(result.floors) ? result.floors : [];
    const total = floors.length;
    const totalUnits = Number(result.totalUnits) || 0;
    const totalChars = Number(result.totalChars) || 0;
    const pageSize = state.pageSize;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * pageSize;
    const visible = floors.slice(start, start + pageSize);
    const maxValue = floors.reduce(
        (max, floor) => Math.max(max, state.unit === 'chars' ? Number(floor[1]) || 0 : Number(floor[0]) || 0),
        0,
    );

    const rows = visible.map((floor, offset) => {
        const units = Number(floor[0]) || 0;
        const chars = Number(floor[1]) || 0;
        const value = state.unit === 'chars' ? chars : units;
        const percent = maxValue > 0 ? Math.max(1, Math.round((value / maxValue) * 100)) : 0;
        return `
            <div class="ccwc-floor-row">
                <span class="ccwc-floor-no">#${start + offset + 1}</span>
                <span class="ccwc-floor-bar"><i style="width:${percent}%"></i></span>
                <span class="ccwc-floor-count">${formatNumber(value)}</span>
            </div>`;
    }).join('');

    const pager = total > 0 ? `
        <div class="ccwc-pager">
            <button type="button" class="ccwc-button" data-action="prev" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
            <span class="ccwc-page-info">第 <b>${state.page}</b> / ${pages} 页</span>
            <button type="button" class="ccwc-button" data-action="next" ${state.page >= pages ? 'disabled' : ''}>下一页</button>
            <label class="ccwc-inline">每页
                <select id="ccwc-page-size" class="ccwc-select ccwc-select-small">
                    ${[50, 100, 200, 500].map(size => `<option value="${size}" ${size === pageSize ? 'selected' : ''}>${size}</option>`).join('')}
                </select>
            </label>
            <label class="ccwc-inline">跳至
                <input id="ccwc-jump" class="ccwc-input ccwc-input-small" type="number" min="1" max="${pages}" value="${state.page}">
                页
            </label>
            <button type="button" class="ccwc-button" data-action="jump">跳转</button>
        </div>` : '';

    const average = total > 0 ? Math.round(totalUnits / total) : 0;
    container.innerHTML = `
        <div class="ccwc-detail-head">
            <h3>${escapeHtml(chat.id)}${chat.isCurrent ? ' <span class="ccwc-tag">当前</span>' : ''}</h3>
            <div class="ccwc-detail-stats">
                <span><b>${formatNumber(total)}</b> 楼</span>
                <span><b>${formatCount(totalUnits, 'units')}</b></span>
                <span><b>${formatCount(totalChars, 'chars')}</b></span>
                <span>平均 <b>${formatNumber(average)}</b> 字/楼</span>
            </div>
        </div>
        ${total > 0 ? `<div class="ccwc-floor-list">${rows}</div>${pager}` : '<div class="ccwc-empty ccwc-detail-empty">这个聊天没有可统计的楼层。</div>'}`;
}

function handleDetailClick(event) {
    const action = event.target.closest?.('[data-action]')?.dataset.action;
    if (!action) return;
    const result = state.results.get(state.selectedId);
    const pages = Math.max(1, Math.ceil((result?.floors?.length ?? 0) / state.pageSize));
    if (action === 'prev') state.page = Math.max(1, state.page - 1);
    else if (action === 'next') state.page = Math.min(pages, state.page + 1);
    else if (action === 'jump') {
        jumpToPage();
        return;
    } else return;
    renderDetail();
}

function jumpToPage() {
    const input = state.overlay?.querySelector('#ccwc-jump');
    const result = state.results.get(state.selectedId);
    const pages = Math.max(1, Math.ceil((result?.floors?.length ?? 0) / state.pageSize));
    const value = Number(input?.value);
    if (!Number.isFinite(value)) return;
    state.page = Math.min(pages, Math.max(1, Math.round(value)));
    renderDetail();
}

function renderProgress() {
    const container = state.overlay?.querySelector('#ccwc-progress');
    if (!container) return;
    if (!state.scanning) {
        container.hidden = true;
        return;
    }

    container.hidden = false;
    const progress = state.progress ?? { done: 0, total: 1, chatName: '', floorsDone: 0, floorsTotal: 0 };
    const total = Math.max(1, progress.total);
    const floorPart = progress.floorsTotal
        ? Math.min(1, progress.floorsDone / progress.floorsTotal)
        : 0;
    const percent = Math.min(100, Math.round(((progress.done + floorPart) / total) * 100));
    const bar = state.overlay?.querySelector('#ccwc-progress-bar');
    if (bar) bar.style.width = `${percent}%`;
    const text = state.overlay?.querySelector('#ccwc-progress-text');
    if (text) {
        if (progress.done >= total) {
            text.textContent = '正在收尾…';
        } else {
            const floorText = progress.floorsTotal
                ? `（${progress.floorsDone}/${progress.floorsTotal} 楼）`
                : '';
            text.textContent = `正在统计 ${progress.done + 1}/${total}：${progress.chatName || ''}${floorText}`;
        }
    }
}

function exportCsv() {
    const completed = [...state.results.values()].filter(result => !result.error);
    if (completed.length === 0) {
        notify('warning', '还没有可导出的统计数据。');
        return;
    }

    const rows = [['聊天', '楼层', '字数', '字符数', '最后消息']];
    for (const chat of state.chats) {
        const result = state.results.get(chat.id);
        if (!result || result.error) continue;
        rows.push([
            chat.id,
            result.floors?.length ?? 0,
            result.totalUnits ?? 0,
            result.totalChars ?? 0,
            formatDate(chat.lastMes),
        ]);
    }
    rows.push([]);
    rows.push(['楼层明细']);
    rows.push(['聊天', '楼层', '字数', '字符数']);
    for (const chat of state.chats) {
        const result = state.results.get(chat.id);
        if (!result || result.error) continue;
        (result.floors ?? []).forEach((floor, index) => {
            rows.push([chat.id, index + 1, Number(floor[0]) || 0, Number(floor[1]) || 0]);
        });
    }

    const content = rows
        .map(row => row.map(csvCell).join(','))
        .join('\r\n');
    const characterName = state.character?.name || '角色卡';
    const fileName = `字数统计_${sanitizeFileName(characterName)}_${new Date().toISOString().slice(0, 10)}.csv`;
    downloadText(fileName, `\ufeff${content}`);
}

function csvCell(value) {
    if (value === null || value === undefined) return '""';
    return `"${String(value).replace(/"/g, '""')}"`;
}

function sanitizeFileName(value) {
    return String(value).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '角色卡';
}

function downloadText(fileName, content) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('zh-CN') : '0';
}

function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 19);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[character]);
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
            const parsed = sanitizeSettings(JSON.parse(raw));
            if (Array.isArray(parsed.tags)) return parsed;
        }
    } catch {
        // 设置损坏时回到默认值。
    }
    return cloneDefaultSettings();
}

function saveSettings(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // 隐私模式下保存失败不影响本次统计。
    }
}

function loadUnit() {
    try {
        return localStorage.getItem(UNIT_KEY) === 'chars' ? 'chars' : 'units';
    } catch {
        return 'units';
    }
}

function notify(kind, message) {
    const toastr = window.toastr;
    if (toastr && typeof toastr[kind] === 'function') {
        toastr[kind](message);
        return;
    }
    if (kind === 'error') console.error(`[${EXTENSION_ID}]`, message);
    else console.info(`[${EXTENSION_ID}]`, message);
}
