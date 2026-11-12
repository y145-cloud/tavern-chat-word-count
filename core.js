/**
 * 角色卡字数统计 — 纯函数/统计算法
 *
 * 统计算法刻意与“楼层正文计数器”保持一致：
 *  - 先按“排除标签 / 只取标签”得到正文；
 *  - 去掉代码块、HTML 注释、图片、链接地址、行内代码、{{宏}}、URL、HTML 标签、Markdown 行首标记；
 *  - 汉字/假名/谚文每字算 1，其余语言按“词”算 1（数字串也算 1 词）。
 * 这样本插件算出的单层字数，与楼层徽标上的数字可以对上。
 *
 * 该文件不碰 DOM、不碰网络，方便用 Node 直接做单元测试。
 */

export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 64;
export const MAX_TAG_INPUT_LENGTH = 2048;

export const ALWAYS_IGNORED_TAGS = Object.freeze(['script', 'style', 'svg', 'head']);

export const DEFAULT_SETTINGS = Object.freeze({
    mode: 'exclude',
    tags: [
        'think',
        'thinking',
        'analysis',
        'reasoning',
        'details',
        'status',
        'statusbar',
        'statusblock',
        'statebar',
        'stateblock',
        'updatevariable',
    ],
});

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+(?:[-'’][\p{L}\p{M}\p{N}]+)*/gu;

export function cloneDefaultSettings() {
    return { mode: DEFAULT_SETTINGS.mode, tags: [...DEFAULT_SETTINGS.tags] };
}

export function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从用户输入里解析标签。
 * 支持 `<content>`、`content`，以及空格/中英文逗号/顿号/分号/换行分隔。
 */
export function parseTagList(input) {
    const text = String(input ?? '').slice(0, MAX_TAG_INPUT_LENGTH);
    const angleTags = [...text.matchAll(/<\s*\/?\s*([\p{L}_][\p{L}\p{N}_.:-]*)\b[^>]*>/gu)].map(
        match => match[1],
    );
    const plainTags = text
        .replace(/<[^>]*>/g, ' ')
        .split(/[\s,，、;；]+/u)
        .map(tag => tag.trim())
        .filter(tag => /^[\p{L}_][\p{L}\p{N}_.:-]*$/u.test(tag));

    return [...new Set([...angleTags, ...plainTags].map(tag => tag.toLowerCase()))]
        .filter(tag => tag.length > 0 && tag.length <= MAX_TAG_LENGTH)
        .slice(0, MAX_TAGS);
}

export function sanitizeSettings(value) {
    const mode = value?.mode === 'extract' ? 'extract' : 'exclude';
    const rawTags = Array.isArray(value?.tags) ? value.tags.join('\n') : value?.tags;
    const tags = parseTagList(rawTags);
    return { mode, tags };
}

/** 缓存键：只看规则，不看显示单位。标签顺序不影响结果。 */
export function settingsKey(settings) {
    return `${settings.mode}|${[...settings.tags].sort().join(',')}`;
}

export function decodeHtmlEntities(text) {
    const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        ensp: ' ',
        emsp: ' ',
        thinsp: ' ',
    };
    return String(text).replace(
        /&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z][a-z0-9]+));/gi,
        (_entity, decimal, hex, name) => {
            if (name) return named[name.toLowerCase()] ?? ' ';
            const codePoint = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
            if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return ' ';
            if (codePoint >= 0xd800 && codePoint <= 0xdfff) return ' ';
            return String.fromCodePoint(codePoint);
        },
    );
}

/**
 * 找到同名标签的成对区间，支持同名嵌套。
 * 返回的 contentStart/contentEnd 是不含标签本身的内容区间。
 */
export function findTaggedRanges(text, tagName) {
    const escapedTag = escapeRegExp(tagName);
    const pattern = new RegExp(`<\\s*(\\/?)\\s*${escapedTag}\\b[^>]*>`, 'gi');
    const ranges = [];
    let depth = 0;
    let blockStart = -1;
    let contentStart = -1;

    for (const match of text.matchAll(pattern)) {
        const isClosing = match[1] === '/';
        if (!isClosing) {
            if (depth === 0) {
                blockStart = match.index;
                contentStart = match.index + match[0].length;
            }
            depth += 1;
        } else if (depth > 0) {
            depth -= 1;
            if (depth === 0) {
                ranges.push({
                    blockStart,
                    blockEnd: match.index + match[0].length,
                    contentStart,
                    contentEnd: match.index,
                });
            }
        }
    }
    return ranges;
}

export function removeTaggedBlocks(text, tagName) {
    const ranges = findTaggedRanges(text, tagName);
    if (ranges.length === 0) return text;
    let result = '';
    let cursor = 0;
    for (const range of ranges) {
        result += text.slice(cursor, range.blockStart) + ' ';
        cursor = range.blockEnd;
    }
    return result + text.slice(cursor);
}

export function extractTaggedBlocks(text, tagNames) {
    const ranges = tagNames
        .flatMap(tagName => findTaggedRanges(text, tagName))
        .map(range => ({ start: range.contentStart, end: range.contentEnd }))
        .sort((left, right) => left.start - right.start || right.end - left.end);
    const merged = [];
    for (const range of ranges) {
        const previous = merged[merged.length - 1];
        if (!previous || range.start > previous.end) merged.push({ ...range });
        else previous.end = Math.max(previous.end, range.end);
    }
    return merged.map(range => text.slice(range.start, range.end)).join('\n');
}

/**
 * 提取正文纯文本。注意：即使 extract 模式，也会继续清掉代码块、HTML 等非正文内容。
 */
export function extractBodyText(rawMessage, settings) {
    // 调用方应传入 sanitizeSettings() 后的对象；这里只做轻量兜底，避免每条消息重复解析标签。
    const mode = settings?.mode === 'extract' ? 'extract' : 'exclude';
    const tags = Array.isArray(settings?.tags) ? settings.tags : [];
    let text = String(rawMessage ?? '').replace(/\0/g, ' ');

    if (mode === 'extract') {
        text = tags.length ? extractTaggedBlocks(text, tags) : '';
    } else {
        for (const tagName of tags) text = removeTaggedBlocks(text, tagName);
    }

    // 程序代码、功能标签和标记语法都不属于正文。
    text = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/~~~[\s\S]*?~~~/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ');

    for (const tagName of ALWAYS_IGNORED_TAGS) text = removeTaggedBlocks(text, tagName);

    text = text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`[^`\n]*`/g, ' ')
        .replace(/\{\{[\s\S]*?\}\}/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/gm, '')
        .replace(/[*_~]/g, ' ');

    return decodeHtmlEntities(text).replace(/<[^>]+>/g, ' ');
}

/** 与楼层正文计数器一致的口径：CJK 每字 + 其余按词。 */
export function countUnits(text) {
    const source = String(text ?? '');
    const cjkCount = (source.match(CJK_PATTERN) ?? []).length;
    const nonCjkText = source.replace(CJK_PATTERN, ' ');
    const otherWords = nonCjkText.match(WORD_PATTERN) ?? [];
    return cjkCount + otherWords.length;
}

/** 去掉空白后的字符数（保留标点）。 */
export function countChars(text) {
    return String(text ?? '').replace(/\s+/g, '').length;
}

/** 对一条原始消息做完整分析。 */
export function analyzeMessage(rawMessage, settings) {
    const body = extractBodyText(rawMessage, settings);
    return { units: countUnits(body), chars: countChars(body) };
}

export function isChatHeader(item) {
    return Boolean(
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && !('mes' in item)
        && !('is_user' in item)
        && ('chat_metadata' in item
            || 'user_name' in item
            || 'character_name' in item
            || 'create_date' in item),
    );
}

/**
 * 把 `/api/chats/get` 的返回值归一化成消息数组。
 * SillyTavern / TauriTavern 都返回 `[header, ...messages]`；空聊天返回 `[]` 或 `{}`。
 * 保留没有 mes 的消息槽位（按 0 字计），以保证楼层编号不回退。
 */
export function normalizeMessages(payload) {
    if (!Array.isArray(payload)) return [];
    const start = payload.length > 0 && isChatHeader(payload[0]) ? 1 : 0;
    return payload.slice(start).filter(item => item && typeof item === 'object' && !Array.isArray(item));
}

export function stripJsonlExtension(fileName) {
    return String(fileName ?? '').replace(/\.jsonl$/i, '');
}

export function formatCount(value, unit = 'units') {
    const number = Number(value) || 0;
    const formatted = number.toLocaleString('zh-CN');
    return unit === 'chars' ? `${formatted} 字符` : `${formatted} 字`;
}
