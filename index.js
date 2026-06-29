import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

import {
    charSetAuxWorlds,
    charUpdateAddAuxWorld,
    charUpdatePrimaryWorld,
    createNewWorldInfo,
    deleteWorldInfo,
    getFreeWorldName,
    importWorldInfo,
    loadWorldInfo,
    METADATA_KEY as CHAT_LOREBOOK_METADATA_KEY,
    openWorldInfoEditor,
    saveWorldInfo,
    selected_world_info,
    world_info,
} from '../../../world-info.js';

import { Popup } from '../../../popup.js';
import {
    download,
    ensureImageFormatSupported,
    getBase64Async,
    getCharaFilename,
    saveBase64AsFile,
} from '../../../utils.js';

const MODULE_SETTINGS_KEY = 'lorebookManager';
const LOREBOOK_META_KEY = 'lorebook_manager';
const IMAGE_SUBFOLDER = 'lorebook-manager';
const SPECIAL_FOLDERS = Object.freeze({
    ALL: '__all__',
    ACTIVE: '__active__',
    UNFILED: '__unfiled__',
    LTM: '__ltm__',
});
const PAGE_SIZE_OPTIONS = Object.freeze([10, 25, 50, 100]);

const DEFAULT_SETTINGS = Object.freeze({
    folders: [],
    activeFolderId: SPECIAL_FOLDERS.ALL,
    sort: 'name-asc',
    pageSize: 25,
    openManagerOnDrawer: true,
    tagList: [],
    lorebookTags: {},
    pinnedBooks: [],
});

// Double-tap tracker for card selection vs open (declared early so closeManager
// can safely reset it regardless of file ordering).
let _lastCardTapTime = 0;
let _lastCardTapName = '';
const DOUBLE_TAP_MS = 350;

const state = {
    initialized: false,
    isOpen: false,
    isLoading: false,
    lorebooks: [],
    entryCounts: {},
    activeFolderId: SPECIAL_FOLDERS.ALL,
    search: '',
    sort: DEFAULT_SETTINGS.sort,
    pageSize: DEFAULT_SETTINGS.pageSize,
    currentPage: 1,
    pendingCoverTarget: '',
    refreshToken: 0,
    refreshTimer: null,
    activeLorebookNames: new Set(),
    selectedBooks: new Set(),
    dom: {},
    buttonObserver: null,
    worldListObserver: null,
    worldListElement: null,
    toolbarSyncFrame: 0,
    activeTagFilter: null,
};

const EXTENSION_NAME = (() => {
    try {
        const pathname = new URL(import.meta.url).pathname;
        const match = pathname.match(/\/scripts\/extensions\/(.+)\/[^/]+$/);
        if (match?.[1]) {
            return decodeURIComponent(match[1]);
        }
    } catch (error) {
        console.warn('[Lorebook Manager] Failed to derive extension name from URL', error);
    }
    return 'third-party/My-lorebook-manager';
})();

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function getManagerSettings() {
    if (!isObject(extension_settings[MODULE_SETTINGS_KEY])) {
        extension_settings[MODULE_SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = extension_settings[MODULE_SETTINGS_KEY];
    if (!Array.isArray(settings.folders)) {
        settings.folders = [];
    }
    if (typeof settings.activeFolderId !== 'string') {
        settings.activeFolderId = DEFAULT_SETTINGS.activeFolderId;
    }
    if (typeof settings.sort !== 'string') {
        settings.sort = DEFAULT_SETTINGS.sort;
    }
    settings.pageSize = normalizePageSize(settings.pageSize);

    return settings;
}

function normalizePageSize(value) {
    const numericValue = Number(value);
    return PAGE_SIZE_OPTIONS.includes(numericValue) ? numericValue : DEFAULT_SETTINGS.pageSize;
}

function saveManagerSettings() {
    getContext().saveSettingsDebounced();
}

function getFolders() {
    return getManagerSettings().folders;
}

function setActiveFolder(folderId) {
    const settings = getManagerSettings();
    settings.activeFolderId = folderId;
    state.activeFolderId = folderId;
    state.currentPage = 1;
    saveManagerSettings();
    renderManager();
}

function clampCurrentPage(totalItems = getVisibleLorebooks().length) {
    const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize));
    state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
    return totalPages;
}

function setCurrentPage(pageNumber) {
    state.currentPage = Math.max(1, Number(pageNumber) || 1);
    clampCurrentPage();
    state.dom.grid?.scrollTo?.({ top: 0, behavior: 'auto' });
    renderManager();
}

function getFolderById(folderId) {
    return getFolders().find(folder => folder.id === folderId) || null;
}

function getSortedFolders(parentId = null) {
    return getFolders()
        .filter(folder => (folder.parentId || null) === parentId)
        .slice()
        .sort((a, b) => {
            const aRank = Number(a.sortOrder ?? 0);
            const bRank = Number(b.sortOrder ?? 0);
            return aRank - bRank || String(a.name).localeCompare(String(b.name));
        });
}

function getFolderChain(folderId) {
    const chain = [];
    const visited = new Set();
    let currentId = folderId || null;

    while (currentId) {
        if (visited.has(currentId)) {
            break;
        }
        visited.add(currentId);

        const folder = getFolderById(currentId);
        if (!folder) {
            break;
        }

        chain.unshift(folder);
        currentId = folder.parentId || null;
    }

    return chain;
}

function getFolderPathLabel(folderId) {
    if (!folderId) {
        return 'No Folder';
    }

    const chain = getFolderChain(folderId);
    return chain.length ? chain.map(folder => folder.name).join(' / ') : 'No Folder';
}

function getFolderSubtreeIds(folderId) {
    const ids = new Set();
    if (!folderId) {
        return ids;
    }

    const queue = [folderId];
    while (queue.length) {
        const currentId = queue.shift();
        if (!currentId || ids.has(currentId)) {
            continue;
        }

        ids.add(currentId);
        const children = getFolders().filter(folder => folder.parentId === currentId);
        children.forEach(child => queue.push(child.id));
    }

    return ids;
}

function countLorebooksForFolder(folderId) {
    const subtree = getFolderSubtreeIds(folderId);
    return state.lorebooks.filter(record => subtree.has(record.folderId)).length;
}

function countUnfiledLorebooks() {
    return state.lorebooks.filter(record => !record.folderId).length;
}

function countActiveLorebooks() {
    return state.lorebooks.filter(record => state.activeLorebookNames.has(record.apiName)).length;
}


function isLtmLorebook(record) {
    const name = (record.displayName || record.apiName || '').toLowerCase();
    return name.startsWith('ltm') || name.includes('ltm_') || name.includes('[ltm]') || name.includes('(ltm)');
}

function countLtmLorebooks() {
    return state.lorebooks.filter(record => isLtmLorebook(record)).length;
}

function getPinnedBooks() {
    const settings = getManagerSettings();
    if (!Array.isArray(settings.pinnedBooks)) settings.pinnedBooks = [];
    return settings.pinnedBooks;
}

function isBookPinned(apiName) {
    return getPinnedBooks().includes(apiName);
}

function toggleBookPinned(apiName) {
    const pinned = getPinnedBooks();
    const index = pinned.indexOf(apiName);
    if (index >= 0) {
        pinned.splice(index, 1);
        toastr.info(`Unpinned "${escapeHtml(apiName)}".`);
    } else {
        pinned.push(apiName);
        toastr.success(`Pinned "${escapeHtml(apiName)}".`);
    }
    saveManagerSettings();
    renderManager();
}

function getFirstSeenTimestamp(record) {
    const settings = getManagerSettings();
    return settings.firstSeen?.[record.apiName] || 0;
}

function isRealFolderId(folderId) {
    return Boolean(folderId)
        && folderId !== SPECIAL_FOLDERS.ALL
        && folderId !== SPECIAL_FOLDERS.ACTIVE
        && folderId !== SPECIAL_FOLDERS.UNFILED
        && folderId !== SPECIAL_FOLDERS.LTM;
}

function findCharacterByAvatarOrName(identifier, characters) {
    if (!identifier || !Array.isArray(characters)) {
        return null;
    }

    return characters.find(character => character?.avatar === identifier || character?.name === identifier) || null;
}

function getCharacterExtraLorebooks(character) {
    const avatarKey = character?.avatar;
    if (!avatarKey) {
        return [];
    }

    const fileName = getCharaFilename(null, { manualAvatarKey: avatarKey });
    const charLore = Array.isArray(world_info.charLore)
        ? world_info.charLore.find(entry => entry?.name === fileName)
        : null;

    return Array.isArray(charLore?.extraBooks)
        ? charLore.extraBooks.filter(name => typeof name === 'string' && name.trim())
        : [];
}

function collectCharacterLorebooks(activeLorebooks, character) {
    const primaryLorebook = character?.data?.extensions?.world;
    if (typeof primaryLorebook === 'string' && primaryLorebook.trim()) {
        activeLorebooks.add(primaryLorebook.trim());
    }

    getCharacterExtraLorebooks(character).forEach(name => activeLorebooks.add(name.trim()));
}

function syncActiveLorebooks() {
    const context = getContext();
    const activeLorebooks = new Set();

    selected_world_info
        .filter(name => typeof name === 'string' && name.trim())
        .forEach(name => activeLorebooks.add(name.trim()));

    const chatLorebook = context.chatMetadata?.[CHAT_LOREBOOK_METADATA_KEY];
    if (typeof chatLorebook === 'string' && chatLorebook.trim()) {
        activeLorebooks.add(chatLorebook.trim());
    }

    if (context.groupId) {
        const group = Array.isArray(context.groups)
            ? context.groups.find(candidate => String(candidate?.id) === String(context.groupId))
            : null;

        (group?.members ?? []).forEach(member => {
            collectCharacterLorebooks(activeLorebooks, findCharacterByAvatarOrName(member, context.characters));
        });
    } else {
        collectCharacterLorebooks(activeLorebooks, context.characters?.[context.characterId]);
    }

    state.activeLorebookNames = activeLorebooks;
}

function normalizeLorebookMeta(rawMeta) {
    if (!isObject(rawMeta)) {
        return {};
    }

    const meta = {};

    if (typeof rawMeta.bookId === 'string' && rawMeta.bookId.trim()) {
        meta.bookId = rawMeta.bookId.trim();
    }

    if (typeof rawMeta.folderId === 'string' && rawMeta.folderId.trim()) {
        meta.folderId = rawMeta.folderId.trim();
    }

    if (typeof rawMeta.coverPath === 'string' && rawMeta.coverPath.trim()) {
        const candidate = rawMeta.coverPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
        if (isSafeCoverPath(candidate)) {
            meta.coverPath = candidate;
        }
    }

    // Cache-busting token bumped whenever the cover image is (re)uploaded.
    // The file path stays identical across uploads with the same extension, so
    // without this the browser keeps serving the previously cached image.
    if (meta.coverPath) {
        const rawVersion = Number(rawMeta.coverVersion);
        if (Number.isFinite(rawVersion) && rawVersion > 0) {
            meta.coverVersion = Math.floor(rawVersion);
        }
    }

    return meta;
}

function isSafeCoverPath(path) {
    if (typeof path !== 'string' || !path) {
        return false;
    }

    // Reject absolute paths, parent traversal, NUL bytes and protocol-style URLs.
    if (path.includes('..') || path.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
        return false;
    }

    // Cover assets must live inside the manager's image subfolder.
    return path.includes(`/${IMAGE_SUBFOLDER}/`) || path.startsWith(`${IMAGE_SUBFOLDER}/`);
}

function cleanLorebookMeta(meta) {
    const normalized = normalizeLorebookMeta(meta);
    return Object.keys(normalized).length ? normalized : null;
}

function normalizeLorebookRecord(item) {
    const managerMeta = normalizeLorebookMeta(item?.extensions?.[LOREBOOK_META_KEY]);
    const apiName = String(item?.file_id || item?.name || '').trim();
    const displayName = String(item?.name || apiName).trim() || apiName;

    return {
        apiName,
        displayName,
        bookId: managerMeta.bookId || '',
        folderId: managerMeta.folderId || null,
        coverPath: managerMeta.coverPath || '',
        coverVersion: managerMeta.coverVersion || 0,
        entryCount: Object.hasOwn(state.entryCounts, apiName) ? state.entryCounts[apiName] : null,
    };
}

function getLorebookMetaFromData(data) {
    if (!isObject(data) || !isObject(data.extensions)) {
        return {};
    }

    return normalizeLorebookMeta(data.extensions[LOREBOOK_META_KEY]);
}

function toClientImagePath(path, version) {
    if (!path) {
        return '';
    }

    const clean = `/${String(path).replace(/^[\\/]+/, '').replace(/\\/g, '/')}`;
    const token = Number(version);
    if (Number.isFinite(token) && token > 0) {
        return `${clean}?v=${Math.floor(token)}`;
    }

    return clean;
}

function findLorebook(apiName) {
    return state.lorebooks.find(record => record.apiName === apiName) || null;
}

function applyLorebookMetaToState(apiName, meta) {
    const normalized = cleanLorebookMeta(meta) || {};

    state.lorebooks = state.lorebooks.map(record => {
        if (record.apiName !== apiName) {
            return record;
        }

        return {
            ...record,
            bookId: normalized.bookId || '',
            folderId: normalized.folderId || null,
            coverPath: normalized.coverPath || '',
            coverVersion: normalized.coverVersion || 0,
        };
    });

    updateWorldToolbarButtons();
}

function getSortableEntryCount(record, direction) {
    if (typeof record.entryCount === 'number') {
        return record.entryCount;
    }

    return direction === 'asc' ? Number.MAX_SAFE_INTEGER : -1;
}

function compareLorebooks(a, b) {
    // Pinned items always float to the top regardless of sort order
    const aPinned = isBookPinned(a.apiName) ? 0 : 1;
    const bPinned = isBookPinned(b.apiName) ? 0 : 1;
    if (aPinned !== bPinned) return aPinned - bPinned;

    switch (state.sort) {
        case 'name-desc':
            return String(b.displayName).localeCompare(String(a.displayName)) || String(b.apiName).localeCompare(String(a.apiName));
        case 'entries-desc':
            return getSortableEntryCount(b, 'desc') - getSortableEntryCount(a, 'desc') || String(a.displayName).localeCompare(String(b.displayName));
        case 'entries-asc':
            return getSortableEntryCount(a, 'asc') - getSortableEntryCount(b, 'asc') || String(a.displayName).localeCompare(String(b.displayName));
        case 'recent-desc':
            return (getFirstSeenTimestamp(b) - getFirstSeenTimestamp(a)) || String(b.apiName).localeCompare(String(a.apiName));
        case 'recent-asc':
            return (getFirstSeenTimestamp(a) - getFirstSeenTimestamp(b)) || String(a.apiName).localeCompare(String(b.apiName));
        case 'name-asc':
        default:
            return String(a.displayName).localeCompare(String(b.displayName)) || String(a.apiName).localeCompare(String(b.apiName));
    }
}

function getVisibleLorebooks() {
    const searchTerm = state.search.trim().toLowerCase();
    const folderFilter = state.activeFolderId;
    const subtree = isRealFolderId(folderFilter) ? getFolderSubtreeIds(folderFilter) : null;

    return state.lorebooks
        .filter(record => {
            if (folderFilter === SPECIAL_FOLDERS.ACTIVE && !state.activeLorebookNames.has(record.apiName)) {
                return false;
            }
            if (folderFilter === SPECIAL_FOLDERS.LTM && !isLtmLorebook(record)) {
                return false;
            }

            if (folderFilter === SPECIAL_FOLDERS.UNFILED && record.folderId) {
                return false;
            }

            if (subtree && !subtree.has(record.folderId)) {
                return false;
            }

            if (state.activeTagFilter) {
                const bookTags = getLorebookTags(record.apiName);
                if (!bookTags.includes(state.activeTagFilter)) {
                    return false;
                }
            }

            if (!searchTerm) {
                return true;
            }

            const haystack = [
                record.displayName,
                record.apiName,
                getFolderPathLabel(record.folderId),
                ...getLorebookTags(record.apiName),
            ].join(' ').toLowerCase();

            return haystack.includes(searchTerm);
        })
        .sort(compareLorebooks);
}

function setLoading(isLoading) {
    state.isLoading = isLoading;

    if (!state.dom.loading) {
        return;
    }

    state.dom.loading.classList.toggle('lmb_hidden', !isLoading);
}

function setEmptyMessage(message = '') {
    if (!state.dom.empty) {
        return;
    }

    state.dom.empty.textContent = message;
    state.dom.empty.classList.toggle('lmb_hidden', !message);
}

async function ensureManagerDom() {
    if (state.dom.modal) {
        return;
    }

    const host = document.createElement('div');
    host.innerHTML = await renderExtensionTemplateAsync(EXTENSION_NAME, 'manager');

    const modal = host.firstElementChild;
    if (!modal) {
        throw new Error('Failed to render Lorebook Manager template');
    }

    document.body.appendChild(modal);

    state.dom = {
        modal,
        refresh: modal.querySelector('#lmb_refresh'),
        search: modal.querySelector('#lmb_search'),
        sort: modal.querySelector('#lmb_sort'),
        pageSize: modal.querySelector('#lmb_page_size'),
        newLorebook: modal.querySelector('#lmb_new_lorebook'),
        importLorebook: modal.querySelector('#lmb_import_lorebook'),
        exportLorebook: modal.querySelector('#lmb_export_lorebook'),
        newFolder: modal.querySelector('#lmb_new_folder'),
        newSubfolder: modal.querySelector('#lmb_new_subfolder'),
        folderTree: modal.querySelector('#lmb_folder_tree'),
        breadcrumb: modal.querySelector('#lmb_breadcrumb'),
        summary: modal.querySelector('#lmb_summary'),
        pageControls: modal.querySelector('#lmb_page_controls'),
        pageLabel: modal.querySelector('#lmb_page_label'),
        prevPage: modal.querySelector('#lmb_prev_page'),
        nextPage: modal.querySelector('#lmb_next_page'),
        loading: modal.querySelector('#lmb_loading'),
        empty: modal.querySelector('#lmb_empty'),
        grid: modal.querySelector('#lmb_grid'),
        coverInput: modal.querySelector('#lmb_cover_input'),
        importInput: modal.querySelector('#lmb_import_input'),
        selectBar: modal.querySelector('#lmb_select_bar'),
        selectCount: modal.querySelector('#lmb_select_count'),
        selectAll: modal.querySelector('#lmb_select_all'),
        deselectAll: modal.querySelector('#lmb_deselect_all'),
        bulkMove: modal.querySelector('#lmb_bulk_move'),
        bulkExport: modal.querySelector('#lmb_bulk_export'),
        bulkDelete: modal.querySelector('#lmb_bulk_delete'),
        sidebarToggle: modal.querySelector('#lmb_sidebar_toggle'),
        sidebarToggleLabel: modal.querySelector('#lmb_sidebar_toggle_label'),
        sidebar: modal.querySelector('#lmb_sidebar'),
    };

    bindManagerEvents();
}

function bindManagerEvents() {
    state.dom.modal.addEventListener('click', onModalClick);
    state.dom.search.addEventListener('input', () => {
        state.search = state.dom.search.value;
        state.currentPage = 1;
        renderManager();
    });
    state.dom.sort.addEventListener('change', () => {
        state.sort = state.dom.sort.value;
        state.currentPage = 1;
        getManagerSettings().sort = state.sort;
        saveManagerSettings();
        renderManager();
    });
    state.dom.pageSize.addEventListener('change', () => {
        state.pageSize = normalizePageSize(state.dom.pageSize.value);
        state.currentPage = 1;
        getManagerSettings().pageSize = state.pageSize;
        saveManagerSettings();
        renderManager();
    });
    state.dom.refresh.addEventListener('click', () => refreshLorebooks({ showLoader: true }));
    state.dom.newLorebook.addEventListener('click', onCreateLorebookClick);
    state.dom.importLorebook.addEventListener('click', () => state.dom.importInput.click());
    state.dom.exportLorebook?.addEventListener('click', onToolbarExportClick);
    state.dom.newFolder.addEventListener('click', () => openCreateFolderPrompt(null));
    state.dom.newSubfolder.addEventListener('click', () => openCreateFolderPrompt(getSelectedRealFolderId()));
    state.dom.prevPage.addEventListener('click', () => setCurrentPage(state.currentPage - 1));
    state.dom.nextPage.addEventListener('click', () => setCurrentPage(state.currentPage + 1));
    state.dom.importInput.addEventListener('change', onImportInputChange);
    state.dom.coverInput.addEventListener('change', onCoverInputChange);
    state.dom.folderTree.addEventListener('click', onFolderTreeClick);
    state.dom.folderTree.addEventListener('dragover', onFolderTreeDragOver);
    state.dom.folderTree.addEventListener('dragleave', onFolderTreeDragLeave);
    state.dom.folderTree.addEventListener('drop', onFolderTreeDrop);
    state.dom.grid.addEventListener('click', onLorebookGridClick);
    state.dom.grid.addEventListener('dblclick', onGridDoubleClick);
    state.dom.grid.addEventListener('change', onLorebookGridChange);
    state.dom.grid.addEventListener('dragstart', onLorebookDragStart);
    state.dom.grid.addEventListener('dragend', onLorebookDragEnd);
    state.dom.grid.addEventListener('error', onCoverImageError, true);

    // Multi-select events
    state.dom.selectAll?.addEventListener('click', onSelectAllClick);
    state.dom.deselectAll?.addEventListener('click', onDeselectAllClick);
    state.dom.bulkDelete?.addEventListener('click', onBulkDeleteClick);
    state.dom.bulkMove?.addEventListener('click', onBulkMoveClick);
    state.dom.bulkExport?.addEventListener('click', onBulkExportClick);
    state.dom.sidebarToggle?.addEventListener('click', onSidebarToggleClick);

    // Close the mobile sidebar overlay when tapping outside of it.
    state.dom.modal.addEventListener('click', onSidebarOutsideClick, true);

    state.dom.grid.addEventListener('click', onGridCheckboxClick);

    // Touch support
    bindTouchEvents();
    injectTouchStyles();

    document.addEventListener('keydown', (event) => {
        if (!state.isOpen || event.key !== 'Escape') {
            return;
        }

        closeManager();
    });
}

function onModalClick(event) {
    const actionElement = event.target.closest('[data-lmb-action]');
    if (!actionElement) {
        return;
    }

    if (actionElement.dataset.lmbAction === 'close') {
        closeManager();
    }
}

async function openManager() {
    await ensureManagerDom();
    collapseWorldInfoDrawer();

    state.isOpen = true;
    state.dom.modal.classList.remove('lmb_hidden');
    state.dom.search.value = state.search;
    state.dom.sort.value = state.sort;
    state.dom.pageSize.value = String(state.pageSize);

    await refreshLorebooks({ showLoader: true });
}

function closeManager() {
    if (!state.dom.modal) {
        return;
    }

    state.isOpen = false;
    clearSelection();
    state.dom.modal.classList.add('lmb_hidden');
    clearDropTargetStyles();

    // Reset double-tap tracker so the next session starts clean.
    _lastCardTapTime = 0;
    _lastCardTapName = '';
}

function getSelectedRealFolderId() {
    return isRealFolderId(state.activeFolderId) ? state.activeFolderId : null;
}

async function fetchLorebookList() {
    const response = await fetch('/api/worldinfo/list', {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        throw new Error(`Failed to load lorebooks (${response.status})`);
    }

    const payload = await response.json();
    return Array.isArray(payload) ? payload.map(normalizeLorebookRecord) : [];
}

async function refreshLorebooks({ showLoader = false } = {}) {
    const refreshToken = ++state.refreshToken;

    if (showLoader) {
        setLoading(true);
    }

    try {
        const lorebooks = await fetchLorebookList();

        if (refreshToken !== state.refreshToken) {
            return;
        }

        state.lorebooks = lorebooks;

        // Track first-seen timestamps for sort
        const fsSettings = getManagerSettings();
        if (!isObject(fsSettings.firstSeen)) { fsSettings.firstSeen = {}; }
        const knownNames = new Set(Object.keys(fsSettings.firstSeen));
        const now = Date.now();
        let hasNewBooks = false;
        for (const record of lorebooks) {
            if (!knownNames.has(record.apiName)) {
                fsSettings.firstSeen[record.apiName] = knownNames.size === 0 ? 0 : now;
                hasNewBooks = true;
            }
        }
        const currentNames = new Set(lorebooks.map(r => r.apiName));
        for (const key of Object.keys(fsSettings.firstSeen)) {
            if (!currentNames.has(key)) { delete fsSettings.firstSeen[key]; }
        }

        // Drop stale cached entry counts so the map doesn't grow unbounded.
        for (const cachedName of Object.keys(state.entryCounts)) {
            if (!currentNames.has(cachedName)) {
                delete state.entryCounts[cachedName];
            }
        }

        if (hasNewBooks) { saveManagerSettings(); }

        const settings = getManagerSettings();
        const folderExists = isRealFolderId(settings.activeFolderId) ? Boolean(getFolderById(settings.activeFolderId)) : true;
        if (!folderExists) {
            settings.activeFolderId = SPECIAL_FOLDERS.ALL;
            saveManagerSettings();
        }

        state.activeFolderId = folderExists ? settings.activeFolderId : SPECIAL_FOLDERS.ALL;
        state.sort = settings.sort || DEFAULT_SETTINGS.sort;
        state.pageSize = normalizePageSize(settings.pageSize);

        updateWorldToolbarButtons();
        renderManager();
        hydrateEntryCounts(lorebooks, refreshToken);
    } catch (error) {
        console.error('[Lorebook Manager] Failed to refresh lorebooks', error);
        setEmptyMessage('Unable to load lorebooks right now.');
        toastr.error('Failed to refresh the Lorebook Manager.');
    } finally {
        if (showLoader) {
            setLoading(false);
        }
    }
}

async function hydrateEntryCounts(lorebooks, refreshToken) {
    const updates = await Promise.all(lorebooks.map(async (record) => {
        try {
            const data = await loadWorldInfo(record.apiName);
            return [record.apiName, getLorebookEntryCount(data)];
        } catch (error) {
            console.warn(`[Lorebook Manager] Failed to load lorebook "${record.apiName}" for count`, error);
            return [record.apiName, null];
        }
    }));

    if (refreshToken !== state.refreshToken) {
        return;
    }

    updates.forEach(([apiName, entryCount]) => {
        if (typeof entryCount === 'number') {
            state.entryCounts[apiName] = entryCount;
        }
    });

    state.lorebooks = state.lorebooks.map(record => ({
        ...record,
        entryCount: Object.hasOwn(state.entryCounts, record.apiName) ? state.entryCounts[record.apiName] : record.entryCount,
    }));

    renderManager();
}

function getLorebookEntryCount(data) {
    if (!isObject(data) || !isObject(data.entries)) {
        return 0;
    }

    return Object.keys(data.entries).length;
}

function renderManager() {
    if (!state.dom.modal || !state.isOpen) {
        return;
    }

    syncActiveLorebooks();
    renderFolderTree();
    renderLorebookGrid();
    renderHeaderState();
    updateSelectUI();
}

function renderHeaderState() {
    if (!state.dom.breadcrumb || !state.dom.summary) {
        return;
    }

    const tagSuffix = state.activeTagFilter ? ` · Tag: ${state.activeTagFilter}` : '';
    const folderLabel = getActiveFolderLabel(state.activeFolderId);
    state.dom.breadcrumb.textContent = folderLabel + tagSuffix;

    if (state.dom.sidebarToggleLabel) {
        // Compact: show only active tag if filtering, otherwise the folder.
        state.dom.sidebarToggleLabel.textContent = state.activeTagFilter
            ? `#${state.activeTagFilter}`
            : folderLabel;
    }

    const visible = getVisibleLorebooks().length;
    const totalPages = clampCurrentPage(visible);
    state.dom.summary.textContent = `${visible} shown / ${state.lorebooks.length} total`;
    state.dom.newSubfolder.disabled = !Boolean(getSelectedRealFolderId());
    state.dom.pageSize.value = String(state.pageSize);

    if (state.dom.pageControls && state.dom.pageLabel && state.dom.prevPage && state.dom.nextPage) {
        const hasPagination = visible > 0;
        state.dom.pageControls.classList.toggle('lmb_hidden', !hasPagination);
        state.dom.pageLabel.textContent = `Page ${state.currentPage} of ${totalPages}`;
        state.dom.prevPage.disabled = state.currentPage <= 1;
        state.dom.nextPage.disabled = state.currentPage >= totalPages;
    }
}

function renderFolderTree() {
    const tree = state.dom.folderTree;
    if (!tree) {
        return;
    }

    tree.innerHTML = '';

    tree.appendChild(createVirtualFolderRow({
        id: SPECIAL_FOLDERS.ALL,
        label: 'All Lorebooks',
        count: state.lorebooks.length,
        iconClass: 'fa-layer-group',
        selectable: true,
        dropTarget: false,
    }));

    tree.appendChild(createVirtualFolderRow({
        id: SPECIAL_FOLDERS.UNFILED,
        label: 'No Folder',
        count: countUnfiledLorebooks(),
        iconClass: 'fa-inbox',
        selectable: true,
        dropTarget: true,
    }));

    tree.appendChild(createVirtualFolderRow({
        id: SPECIAL_FOLDERS.ACTIVE,
        label: 'Active Lorebooks',
        count: countActiveLorebooks(),
        iconClass: 'fa-bolt',
        selectable: true,
        dropTarget: false,
    }));

    tree.appendChild(createVirtualFolderRow({
        id: SPECIAL_FOLDERS.LTM,
        label: 'LTM Memory',
        count: countLtmLorebooks(),
        iconClass: 'fa-brain',
        selectable: true,
        dropTarget: false,
    }));

    // ── Tag filter section ──
    const tagList = getTagList();
    if (tagList.length > 0 || state.activeTagFilter) {
        const tagDivider = document.createElement('div');
        tagDivider.className = 'lmb_folder_divider';
        tagDivider.innerHTML = '<span>Tags</span>';
        tree.appendChild(tagDivider);

        if (state.activeTagFilter) {
            const clearRow = createVirtualFolderRow({
                id: '__clear_tags__',
                label: 'Clear tag filter',
                count: state.lorebooks.length,
                iconClass: 'fa-xmark',
                selectable: true,
                dropTarget: false,
            });
            tree.appendChild(clearRow);
        }

        tagList.forEach(tag => {
            const count = state.lorebooks.filter(r => getLorebookTags(r.apiName).includes(tag)).length;
            const row = createVirtualFolderRow({
                id: '__tag__' + tag,
                label: tag,
                count,
                iconClass: 'fa-tag',
                selectable: true,
                dropTarget: false,
            });
            if (state.activeTagFilter === tag) {
                row.classList.add('is-selected');
            }
            tree.appendChild(row);
        });
    }

    getSortedFolders().forEach(folder => {
        tree.appendChild(createFolderBranch(folder));
    });
}

function createVirtualFolderRow({ id, label, count, iconClass, selectable, dropTarget }) {
    const row = document.createElement('div');
    row.className = 'lmb_virtual_row';
    if (state.activeFolderId === id) {
        row.classList.add('is-selected');
    }

    if (dropTarget) {
        row.dataset.lmbDropTarget = id;
        row.classList.add('lmb_folder_target');
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lmb_virtual_button';
    button.dataset.lmbFolderAction = selectable ? 'select-special' : '';
    button.dataset.folderId = id;

    const icon = document.createElement('i');
    icon.className = `fa-solid ${iconClass}`;

    const labelWrap = document.createElement('span');
    labelWrap.className = 'lmb_folder_label';

    const name = document.createElement('span');
    name.className = 'lmb_folder_name';
    name.textContent = label;

    const countElement = document.createElement('span');
    countElement.className = 'lmb_folder_count';
    countElement.textContent = `${count}`;

    labelWrap.append(icon, name, countElement);
    button.appendChild(labelWrap);
    row.appendChild(button);
    return row;
}

function createFolderBranch(folder) {
    const branch = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'lmb_folder_row lmb_folder_target';
    row.dataset.folderId = folder.id;
    row.dataset.lmbDropTarget = folder.id;

    if (state.activeFolderId === folder.id) {
        row.classList.add('is-selected');
    }

    const children = getSortedFolders(folder.id);
    const hasChildren = children.length > 0;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'lmb_folder_toggle';
    toggle.dataset.lmbFolderAction = 'toggle-folder';
    toggle.dataset.folderId = folder.id;
    toggle.title = folder.collapsed ? 'Expand folder' : 'Collapse folder';
    toggle.innerHTML = hasChildren
        ? `<i class="fa-solid ${folder.collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i>`
        : '<i class="fa-solid fa-minus"></i>';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lmb_folder_button';
    button.dataset.lmbFolderAction = 'select-folder';
    button.dataset.folderId = folder.id;

    const labelWrap = document.createElement('span');
    labelWrap.className = 'lmb_folder_label';

    const icon = document.createElement('i');
    icon.className = `fa-solid ${folder.collapsed ? 'fa-folder' : 'fa-folder-open'}`;

    const name = document.createElement('span');
    name.className = 'lmb_folder_name';
    name.textContent = folder.name;

    const count = document.createElement('span');
    count.className = 'lmb_folder_count';
    count.textContent = `${countLorebooksForFolder(folder.id)}`;

    labelWrap.append(icon, name, count);
    button.appendChild(labelWrap);

    const tools = document.createElement('div');
    tools.className = 'lmb_folder_tools';
    tools.append(
        createFolderToolButton('new-subfolder', folder.id, 'New subfolder', 'fa-folder-plus'),
        createFolderToolButton('rename-folder', folder.id, 'Rename folder', 'fa-pencil'),
        createFolderToolButton('delete-folder', folder.id, 'Delete folder', 'fa-trash-can'),
    );

    row.append(toggle, button, tools);
    branch.appendChild(row);

    if (hasChildren && !folder.collapsed) {
        const childContainer = document.createElement('div');
        childContainer.className = 'lmb_folder_children';
        children.forEach(child => childContainer.appendChild(createFolderBranch(child)));
        branch.appendChild(childContainer);
    }

    return branch;
}

function createFolderToolButton(action, folderId, title, iconClass) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lmb_folder_tool';
    button.dataset.lmbFolderAction = action;
    button.dataset.folderId = folderId;
    button.title = title;
    button.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    return button;
}

function renderLorebookGrid() {
    const grid = state.dom.grid;
    if (!grid) {
        return;
    }

    const visibleLorebooks = getVisibleLorebooks();
    const visibleOnPage = getLorebooksOnCurrentPage(visibleLorebooks);
    const folderOptions = buildFolderOptions();
    const globalLorebooks = new Set(selected_world_info);
    grid.innerHTML = '';

    if (!visibleLorebooks.length) {
        setEmptyMessage(state.isLoading ? '' : 'No lorebooks match this view yet.');
        return;
    }

    setEmptyMessage('');
    visibleOnPage.forEach(record => grid.appendChild(createLorebookCard(record, { folderOptions, globalLorebooks })));
}

function getLorebooksOnCurrentPage(visibleLorebooks) {
    const totalPages = clampCurrentPage(visibleLorebooks.length);
    if (!visibleLorebooks.length) {
        state.currentPage = 1;
        return [];
    }

    const pageNumber = Math.min(state.currentPage, totalPages);
    const startIndex = (pageNumber - 1) * state.pageSize;
    return visibleLorebooks.slice(startIndex, startIndex + state.pageSize);
}

function createLorebookCard(record, { folderOptions, globalLorebooks }) {
    const card = document.createElement('article');
    card.className = 'lmb_card';
    card.draggable = true;
    card.dataset.bookName = record.apiName;

    const cover = document.createElement('div');
    cover.className = 'lmb_card_cover';
    // cover tap = select, double tap = open (handled by card-level listener)
    cover.title = `Open ${record.displayName}`;
    if (record.coverPath) {
        const image = document.createElement('img');
        image.src = toClientImagePath(record.coverPath, record.coverVersion);
        image.alt = `${record.displayName} cover`;
        cover.appendChild(image);
    }

    const fallback = document.createElement('div');
    fallback.className = 'lmb_cover_fallback';
    if (record.coverPath) {
        fallback.classList.add('lmb_hidden');
    }
    fallback.innerHTML = '<i class="fa-solid fa-book-atlas"></i>';
    cover.appendChild(fallback);

    const badges = document.createElement('div');
    badges.className = 'lmb_card_badges';
    getLorebookBadges(record, globalLorebooks).forEach(({ label, iconClass }) => {
        badges.appendChild(createBadge(label, iconClass));
    });
    cover.appendChild(badges);

    // Pin/favorite star
    const pinButton = document.createElement('button');
    pinButton.type = 'button';
    const pinned = isBookPinned(record.apiName);
    pinButton.className = 'lmb_card_pin' + (pinned ? ' is-pinned' : '');
    pinButton.dataset.lmbBookAction = 'toggle-pin';
    pinButton.title = pinned ? 'Unpin lorebook' : 'Pin lorebook';
    pinButton.innerHTML = pinned
        ? '<i class="fa-solid fa-star"></i>'
        : '<i class="fa-regular fa-star"></i>';
    cover.appendChild(pinButton);

    // Selection checkbox
    const checkbox = document.createElement('div');
    checkbox.className = 'lmb_card_checkbox';
    checkbox.innerHTML = state.selectedBooks.has(record.apiName)
        ? '<i class="fa-solid fa-check"></i>'
        : '<i class="fa-regular fa-square"></i>';
    cover.appendChild(checkbox);

    if (state.selectedBooks.has(record.apiName)) {
        card.classList.add('is-selected');
    }

    if (isLtmLorebook(record)) {
        card.classList.add('is-ltm');
    }

    const body = document.createElement('div');
    body.className = 'lmb_card_body';

    const titleRow = document.createElement('div');
    titleRow.className = 'lmb_card_title_row';

    const title = document.createElement('h3');
    title.className = 'lmb_card_title';
    title.textContent = record.displayName;

    const count = document.createElement('span');
    count.className = 'lmb_card_count';
    count.textContent = typeof record.entryCount === 'number'
        ? `${record.entryCount} entries`
        : 'Counting entries';

    titleRow.append(title, count);

    const meta = document.createElement('p');
    meta.className = 'lmb_card_meta';
    meta.textContent = getFolderPathLabel(record.folderId);

    body.append(titleRow, meta);

    const cardTags = getLorebookTags(record.apiName);
    if (cardTags.length) {
        const tagRow = document.createElement('div');
        tagRow.className = 'lmb_card_tags';
        cardTags.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'lmb_tag_chip';
            chip.textContent = tag;
            tagRow.appendChild(chip);
        });
        body.appendChild(tagRow);
    }

    if (record.displayName !== record.apiName) {
        const fileMeta = document.createElement('p');
        fileMeta.className = 'lmb_card_meta';
        fileMeta.textContent = `File: ${record.apiName}`;
        body.appendChild(fileMeta);
    }

    const actions = document.createElement('div');
    actions.className = 'lmb_card_actions';

    const isActive = state.activeLorebookNames.has(record.apiName);
    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'menu_button menu_button_icon interactable lmb_card_toggle_active' + (isActive ? ' is-active' : '');
    toggleButton.dataset.lmbBookAction = 'toggle-active';
    toggleButton.title = isActive ? 'Deactivate lorebook' : 'Activate lorebook';
    toggleButton.innerHTML = isActive
        ? '<i class="fa-solid fa-bolt"></i><span>Active</span>'
        : '<i class="fa-regular fa-bolt"></i><span>Activate</span>';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'menu_button menu_button_icon interactable lmb_card_open';
    openButton.dataset.lmbBookAction = 'open';
    openButton.innerHTML = '<i class="fa-solid fa-book-open"></i><span>Open</span>';

    const folderSelect = createLorebookFolderSelect(record, folderOptions);

    const renameButton = createCardIconButton('rename', 'Rename with the built-in editor', 'fa-pencil');
    const coverButton = createCardIconButton('upload-cover', 'Upload or replace cover', 'fa-image');
    const clearCoverButton = createCardIconButton('clear-cover', 'Remove cover', 'fa-circle-xmark');
    clearCoverButton.setAttribute('aria-label', 'Remove cover');
    if (!record.coverPath) {
        clearCoverButton.classList.add('lmb_hidden');
    }
    const deleteButton = createCardIconButton('delete', 'Delete lorebook', 'fa-trash-can');
    const duplicateButton = createCardIconButton('duplicate', 'Duplicate lorebook', 'fa-clone');
    const statsButton = createCardIconButton('stats', 'View statistics', 'fa-chart-bar');
    const tagsButton = createCardIconButton('edit-tags', 'Edit tags', 'fa-tags');

    const linkCharButton = createCardIconButton('link-character', 'Link to character', 'fa-user-tag');
    const charBindings = getCharacterBindingsForLorebook(record.apiName);
    if (charBindings.length > 0) {
        linkCharButton.classList.add('has-link');
        linkCharButton.classList.add('lmb_card_char_link');
    } else {
        linkCharButton.classList.add('lmb_card_char_link');
    }

    const toolRow = document.createElement('div');
    toolRow.className = 'lmb_card_tool_row';
    toolRow.append(linkCharButton, duplicateButton, statsButton, tagsButton, renameButton, coverButton, clearCoverButton, deleteButton);

    actions.append(toggleButton, openButton, folderSelect, toolRow);
    card.append(cover, body, actions);
    return card;
}

function getActiveFolderLabel(folderId) {
    switch (folderId) {
        case SPECIAL_FOLDERS.ACTIVE:
            return 'Active Lorebooks';
        case SPECIAL_FOLDERS.UNFILED:
            return 'No Folder';
        case SPECIAL_FOLDERS.ALL:
            return 'All lorebooks';
        case SPECIAL_FOLDERS.LTM:
            return 'LTM Memory';
        default:
            return getFolderPathLabel(folderId);
    }
}

function getLorebookBadges(record, globalLorebooks) {
    const badges = [];
    if (state.activeLorebookNames.has(record.apiName)) {
        badges.push({ label: 'Active', iconClass: 'fa-bolt' });
    }
    if (globalLorebooks.has(record.apiName)) {
        badges.push({ label: 'Global', iconClass: 'fa-globe' });
    }
    if (isLtmLorebook(record)) {
        badges.push({ label: 'LTM', iconClass: 'fa-brain' });
    }
    const charBindings = getCharacterBindingsForLorebook(record.apiName);
    for (const binding of charBindings) {
        const typeLabel = binding.type === 'primary' ? 'Primary' : 'Aux';
        badges.push({ label: `${typeLabel}: ${binding.charName}`, iconClass: 'fa-user-tag' });
    }
    if (!record.folderId) {
        badges.push({ label: 'No Folder', iconClass: 'fa-folder' });
    }
    return badges;
}

function createBadge(label, iconClass) {
    const badge = document.createElement('span');
    badge.className = 'lmb_badge';

    const icon = document.createElement('i');
    icon.className = `fa-solid ${iconClass}`;

    // label may contain attacker-controlled text (e.g. a character name from a
    // public card), so build it as a text node rather than interpolating HTML.
    const text = document.createElement('span');
    text.textContent = label;

    badge.append(icon, text);
    return badge;
}

function createCardIconButton(action, title, iconClass) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button menu_button_icon interactable lmb_card_icon_button';
    button.dataset.lmbBookAction = action;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    return button;
}

function createLorebookFolderSelect(record, folderOptions) {
    const folderSelect = document.createElement('select');
    folderSelect.className = 'text_pole textarea_compact lmb_card_folder_select';
    folderSelect.dataset.lmbField = 'folder';
    folderSelect.dataset.bookName = record.apiName;
    folderSelect.title = `Move "${record.displayName}" to a folder`;
    folderSelect.appendChild(new Option('No Folder', ''));
    folderOptions.forEach(option => folderSelect.appendChild(option.cloneNode(true)));
    folderSelect.value = record.folderId || '';
    return folderSelect;
}

function buildFolderOptions() {
    const options = [];

    const appendOptions = (folder, depth) => {
        const prefix = depth > 0 ? `${'| '.repeat(depth)}- ` : '';
        options.push(new Option(`${prefix}${folder.name}`, folder.id));
        getSortedFolders(folder.id).forEach(child => appendOptions(child, depth + 1));
    };

    getSortedFolders().forEach(folder => appendOptions(folder, 0));
    return options;
}

async function onCreateLorebookClick() {
    const defaultName = getFreeWorldName('Lorebook');
    const finalName = await Popup.show.input('Create a new Lorebook', 'Enter a name for the new lorebook:', defaultName);
    if (!finalName) {
        return;
    }

    const created = await createNewWorldInfo(finalName, { interactive: true });
    if (!created) {
        return;
    }

    const folderId = getSelectedRealFolderId();
    if (folderId) {
        await moveLorebookToFolder(finalName, folderId, { silent: true });
    }

    await refreshLorebooks({ showLoader: false });
    toastr.success(`Lorebook "${escapeHtml(finalName)}" created.`);
}

async function onImportInputChange(event) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';

    if (!file) {
        return;
    }

    const before = new Set(state.lorebooks.map(record => record.apiName));
    await importWorldInfo(file);
    await refreshLorebooks({ showLoader: false });

    const imported = state.lorebooks.filter(record => !before.has(record.apiName));
    const folderId = getSelectedRealFolderId();
    if (imported.length === 1 && folderId) {
        await moveLorebookToFolder(imported[0].apiName, folderId, { silent: true });
    }

    if (imported.length === 1) {
        toastr.success(`Imported "${escapeHtml(imported[0].displayName)}".`);
    }
}

// ══════════════════════════════════════════════════════════════
// FEATURE: EXPORT (single JSON + multi ZIP)
// ══════════════════════════════════════════════════════════════

// Toolbar "Export" button. Exports the current selection if any, otherwise
// every lorebook visible on the current page.
async function onToolbarExportClick() {
    let targets = [...state.selectedBooks];

    if (targets.length === 0) {
        targets = getLorebooksOnCurrentPage(getVisibleLorebooks()).map(record => record.apiName);
    }

    if (targets.length === 0) {
        toastr.info('There are no lorebooks to export.');
        return;
    }

    await exportLorebooks(targets);
}

// Selection-bar "Export" button. Exports exactly the selected lorebooks.
async function onBulkExportClick() {
    const targets = [...state.selectedBooks];
    if (targets.length === 0) return;
    await exportLorebooks(targets);
}

// Sanitizes a lorebook name into a safe file name component.
function sanitizeExportFileName(name) {
    return String(name ?? 'lorebook')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'lorebook';
}

// Loads a lorebook and returns { fileName, json } using the exact native
// SillyTavern world-info export shape (plain JSON.stringify of the data).
async function buildLorebookExport(apiName) {
    const data = await loadWorldInfo(apiName);
    if (!data) {
        return null;
    }

    const record = findLorebook(apiName);
    const baseName = sanitizeExportFileName(record?.displayName || apiName);
    return {
        fileName: `${baseName}.json`,
        json: JSON.stringify(data),
    };
}

// Exports one or many lorebooks. A single book downloads as a .json file,
// multiple books are bundled into a .zip archive.
async function exportLorebooks(apiNames) {
    const names = [...new Set(apiNames)].filter(Boolean);
    if (names.length === 0) return;

    try {
        setLoading(true);

        if (names.length === 1) {
            const result = await buildLorebookExport(names[0]);
            if (!result) {
                toastr.error('Failed to load the lorebook for export.');
                return;
            }
            download(result.json, result.fileName, 'application/json');
            toastr.success(`Exported "${escapeHtml(result.fileName)}".`);
            return;
        }

        const files = [];
        const usedNames = new Set();
        let failed = 0;

        for (const apiName of names) {
            const result = await buildLorebookExport(apiName);
            if (!result) {
                failed++;
                continue;
            }

            // Guard against duplicate file names within the same archive.
            let fileName = result.fileName;
            if (usedNames.has(fileName)) {
                const dot = fileName.lastIndexOf('.');
                const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
                const ext = dot > 0 ? fileName.slice(dot) : '';
                let i = 2;
                while (usedNames.has(`${stem} (${i})${ext}`)) i++;
                fileName = `${stem} (${i})${ext}`;
            }
            usedNames.add(fileName);
            files.push({ name: fileName, content: result.json });
        }

        if (files.length === 0) {
            toastr.error('Failed to export the selected lorebooks.');
            return;
        }

        const stamp = new Date().toISOString().slice(0, 10);
        const zipBlob = createZipBlob(files);
        download(zipBlob, `lorebooks-${stamp}.zip`, 'application/zip');

        if (failed > 0) {
            toastr.warning(`Exported ${files.length} lorebook(s); ${failed} failed to load.`);
        } else {
            toastr.success(`Exported ${files.length} lorebooks as a .zip archive.`);
        }
    } catch (error) {
        console.error('[Lorebook Manager] Export failed', error);
        toastr.error('Failed to export lorebook(s).');
    } finally {
        setLoading(false);
    }
}

// ── Minimal ZIP writer (STORE method, no external dependency) ──
// Produces a standard, uncompressed ZIP archive. JSON text compresses poorly
// enough that "store" is fine and keeps the implementation dependency-free.

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Builds a ZIP Blob from [{ name, content }] entries (content is a string).
function createZipBlob(files) {
    const encoder = new TextEncoder();
    const fileParts = [];
    const central = [];
    let offset = 0;

    const dosTime = 0;
    const dosDate = 0x21; // 1980-01-01, a valid neutral timestamp.

    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const dataBytes = encoder.encode(file.content);
        const crc = crc32(dataBytes);
        const size = dataBytes.length;

        const localHeader = new DataView(new ArrayBuffer(30));
        localHeader.setUint32(0, 0x04034b50, true); // local file header signature
        localHeader.setUint16(4, 20, true);          // version needed
        localHeader.setUint16(6, 0x0800, true);      // flags: UTF-8 names
        localHeader.setUint16(8, 0, true);           // compression: store
        localHeader.setUint16(10, dosTime, true);
        localHeader.setUint16(12, dosDate, true);
        localHeader.setUint32(14, crc, true);
        localHeader.setUint32(18, size, true);       // compressed size
        localHeader.setUint32(22, size, true);       // uncompressed size
        localHeader.setUint16(26, nameBytes.length, true);
        localHeader.setUint16(28, 0, true);          // extra field length

        fileParts.push(new Uint8Array(localHeader.buffer), nameBytes, dataBytes);

        const centralHeader = new DataView(new ArrayBuffer(46));
        centralHeader.setUint32(0, 0x02014b50, true); // central dir signature
        centralHeader.setUint16(4, 20, true);          // version made by
        centralHeader.setUint16(6, 20, true);          // version needed
        centralHeader.setUint16(8, 0x0800, true);      // flags: UTF-8
        centralHeader.setUint16(10, 0, true);          // compression: store
        centralHeader.setUint16(12, dosTime, true);
        centralHeader.setUint16(14, dosDate, true);
        centralHeader.setUint32(16, crc, true);
        centralHeader.setUint32(20, size, true);
        centralHeader.setUint32(24, size, true);
        centralHeader.setUint16(28, nameBytes.length, true);
        centralHeader.setUint16(30, 0, true);          // extra field length
        centralHeader.setUint16(32, 0, true);          // comment length
        centralHeader.setUint16(34, 0, true);          // disk number start
        centralHeader.setUint16(36, 0, true);          // internal attrs
        centralHeader.setUint32(38, 0, true);          // external attrs
        centralHeader.setUint32(42, offset, true);     // local header offset

        central.push(new Uint8Array(centralHeader.buffer), nameBytes);

        offset += 30 + nameBytes.length + size;
    }

    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const centralOffset = offset;

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);          // end of central dir signature
    end.setUint16(4, 0, true);                    // disk number
    end.setUint16(6, 0, true);                    // disk with central dir
    end.setUint16(8, files.length, true);         // entries on this disk
    end.setUint16(10, files.length, true);        // total entries
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralOffset, true);
    end.setUint16(20, 0, true);                   // comment length

    return new Blob([...fileParts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

async function onCoverInputChange(event) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';

    const apiName = state.pendingCoverTarget;
    state.pendingCoverTarget = '';

    if (!file || !apiName) {
        return;
    }

    try {
        const normalizedFile = await ensureImageFormatSupported(file);
        const dataUrl = await getBase64Async(normalizedFile);
        const base64 = dataUrl.split(',')[1];
        const extension = getFileExtension(normalizedFile);
        const stableId = await ensureStableLorebookId(apiName);
        const previousCoverPath = findLorebook(apiName)?.coverPath || '';
        const coverPath = await saveBase64AsFile(base64, IMAGE_SUBFOLDER, `${stableId}-cover`, extension);
        const coverVersion = Date.now();
        const meta = await mutateLorebookMeta(apiName, current => ({ ...current, coverPath, coverVersion }));

        // If the new cover landed at a different path (e.g. a different file
        // extension), the old file is now orphaned on disk — clean it up.
        if (previousCoverPath && previousCoverPath !== coverPath) {
            try {
                await deleteCoverAsset(previousCoverPath);
            } catch (cleanupError) {
                console.warn('[Lorebook Manager] Failed to delete previous cover asset', cleanupError);
            }
        }

        applyLorebookMetaToState(apiName, meta);
        renderManager();
        toastr.success('Lorebook cover updated.');
    } catch (error) {
        console.error('[Lorebook Manager] Failed to upload cover', error);
        toastr.error('Failed to upload the cover image.');
    }
}

function getFileExtension(file) {
    if (file.type?.includes('/')) {
        return file.type.split('/')[1].toLowerCase();
    }

    const match = String(file.name || '').match(/\.([a-z0-9]+)$/i);
    return match?.[1]?.toLowerCase() || 'png';
}

async function onFolderTreeClick(event) {
    const actionElement = event.target.closest('[data-lmb-folder-action]');
    if (!actionElement) {
        return;
    }

    const action = actionElement.dataset.lmbFolderAction;
    const folderId = actionElement.dataset.folderId || '';

    switch (action) {
        case 'select-special':
            if (folderId === '__clear_tags__') {
                state.activeTagFilter = null;
                state.currentPage = 1;
                renderManager();
            } else if (folderId.startsWith('__tag__')) {
                state.activeTagFilter = folderId.slice(7);
                state.currentPage = 1;
                renderManager();
            } else {
                state.activeTagFilter = null;
                setActiveFolder(folderId);
            }
            collapseMobileSidebar();
            break;
        case 'select-folder':
            setActiveFolder(folderId);
            collapseMobileSidebar();
            break;
        case 'toggle-folder':
            toggleFolderCollapsed(folderId);
            break;
        case 'new-subfolder':
            openCreateFolderPrompt(folderId);
            break;
        case 'rename-folder':
            openRenameFolderPrompt(folderId);
            break;
        case 'delete-folder':
            await deleteFolderAndReassign(folderId);
            break;
        default:
            break;
    }
}

function onFolderTreeDragOver(event) {
    const target = event.target.closest('[data-lmb-drop-target]');
    if (!target) {
        return;
    }

    event.preventDefault();
    clearDropTargetStyles();
    target.classList.add('is-drop-target');
}

function onFolderTreeDragLeave(event) {
    const target = event.target.closest('[data-lmb-drop-target]');
    if (!target) {
        return;
    }

    target.classList.remove('is-drop-target');
}

async function onFolderTreeDrop(event) {
    const target = event.target.closest('[data-lmb-drop-target]');
    const apiName = event.dataTransfer?.getData('text/lorebook-name');

    clearDropTargetStyles();

    if (!target || !apiName) {
        return;
    }

    event.preventDefault();

    const rawTarget = target.dataset.lmbDropTarget;
    const folderId = rawTarget === SPECIAL_FOLDERS.UNFILED ? null : rawTarget;
    await moveLorebookToFolder(apiName, folderId);
}

function clearDropTargetStyles() {
    state.dom.folderTree?.querySelectorAll('.is-drop-target').forEach(node => node.classList.remove('is-drop-target'));
}


async function toggleLorebookActive(apiName) {
    const index = selected_world_info.indexOf(apiName);
    if (index >= 0) {
        selected_world_info.splice(index, 1);
        toastr.info(`Deactivated "${escapeHtml(apiName)}".`);
    } else {
        selected_world_info.push(apiName);
        toastr.success(`Activated "${escapeHtml(apiName)}".`);
    }
    getContext().saveSettingsDebounced();
    syncActiveLorebooks();
    renderManager();
}

async function onLorebookGridClick(event) {
    const actionElement = event.target.closest('[data-lmb-book-action]');
    if (!actionElement) {
        return;
    }

    const card = actionElement.closest('.lmb_card');
    const apiName = card?.dataset.bookName || '';
    if (!apiName) {
        return;
    }

    switch (actionElement.dataset.lmbBookAction) {
        case 'open':
            closeManager();
            openWorldInfoEditor(apiName);
            break;
        case 'rename':
            closeManager();
            openWorldInfoEditor(apiName);
            requestAnimationFrame(() => {
                setTimeout(() => {
                    document.getElementById('world_popup_name_button')?.click();
                }, 75);
            });
            break;
        case 'upload-cover':
            state.pendingCoverTarget = apiName;
            state.dom.coverInput.click();
            break;
        case 'clear-cover':
            await clearLorebookCover(apiName);
            break;
        case 'toggle-active':
            await toggleLorebookActive(apiName);
            break;
        case 'duplicate':
            await duplicateLorebook(apiName);
            break;
        case 'stats':
            await showLorebookStats(apiName);
            break;
        case 'edit-tags':
            await openTagEditor(apiName);
            break;
        case 'toggle-pin':
            toggleBookPinned(apiName);
            break;
        case 'link-character':
            await openCharacterLinkPopup(apiName);
            break;
        case 'delete':
            await deleteLorebookWithCover(apiName);
            break;
        default:
            break;
    }
}

async function onLorebookGridChange(event) {
    const select = event.target.closest('[data-lmb-field="folder"]');
    if (!select) {
        return;
    }

    const apiName = select.dataset.bookName || '';
    if (!apiName) {
        return;
    }

    await moveLorebookToFolder(apiName, select.value || null);
}

function onLorebookDragStart(event) {
    const card = event.target.closest('.lmb_card');
    if (!card || !event.dataTransfer) {
        return;
    }

    event.dataTransfer.setData('text/lorebook-name', card.dataset.bookName || '');
    card.classList.add('is-dragging');
}

function onLorebookDragEnd(event) {
    const card = event.target.closest('.lmb_card');
    card?.classList.remove('is-dragging');
}

function onCoverImageError(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) {
        return;
    }

    const cover = image.closest('.lmb_card_cover');
    cover?.classList.add('is-broken');
    cover?.querySelector('.lmb_cover_fallback')?.classList.remove('lmb_hidden');
}

function toggleFolderCollapsed(folderId) {
    const folder = getFolderById(folderId);
    if (!folder) {
        return;
    }

    folder.collapsed = !folder.collapsed;
    saveManagerSettings();
    renderManager();
}

async function openCreateFolderPrompt(parentId) {
    const parentLabel = parentId ? getFolderPathLabel(parentId) : 'root';
    const name = await Popup.show.input('Create folder', `Enter a name for the folder in ${escapeHtml(parentLabel)}:`, '');
    if (!name || !name.trim()) {
        return;
    }

    const folder = {
        id: getContext().uuidv4(),
        name: name.trim(),
        parentId: parentId || null,
        collapsed: false,
        sortOrder: Date.now(),
    };

    getFolders().push(folder);
    saveManagerSettings();
    setActiveFolder(folder.id);
}

async function openRenameFolderPrompt(folderId) {
    const folder = getFolderById(folderId);
    if (!folder) {
        return;
    }

    const nextName = await Popup.show.input('Rename folder', 'Enter a new folder name:', folder.name);
    if (!nextName || !nextName.trim()) {
        return;
    }

    folder.name = nextName.trim();
    saveManagerSettings();
    renderManager();
}

async function deleteFolderAndReassign(folderId) {
    const folder = getFolderById(folderId);
    if (!folder) {
        return;
    }

    const assignedLorebooks = state.lorebooks.filter(record => record.folderId === folderId);
    const confirmed = await Popup.show.confirm(
        `Delete folder "${escapeHtml(folder.name)}"?`,
        `Subfolders move up one level and ${assignedLorebooks.length} lorebook(s) will move to ${escapeHtml(folder.parentId ? getFolderPathLabel(folder.parentId) : 'No Folder')}.`,
    );

    if (!confirmed) {
        return;
    }

    getFolders().forEach(candidate => {
        if (candidate.parentId === folderId) {
            candidate.parentId = folder.parentId || null;
        }
    });

    const settings = getManagerSettings();
    settings.folders = settings.folders.filter(candidate => candidate.id !== folderId);
    if (state.activeFolderId === folderId) {
        settings.activeFolderId = folder.parentId || SPECIAL_FOLDERS.ALL;
        state.activeFolderId = settings.activeFolderId;
    }
    saveManagerSettings();

    for (const record of assignedLorebooks) {
        await moveLorebookToFolder(record.apiName, folder.parentId || null, { silent: true });
    }

    renderManager();
}

async function moveLorebookToFolder(apiName, folderId, { silent = false } = {}) {
    try {
        const folder = folderId ? getFolderById(folderId) : null;
        const normalizedFolderId = folder ? folder.id : null;
        const current = findLorebook(apiName);

        if (current && current.folderId === normalizedFolderId) {
            return;
        }

        const meta = await mutateLorebookMeta(apiName, existing => ({
            ...existing,
            folderId: normalizedFolderId || '',
        }));

        applyLorebookMetaToState(apiName, meta);
        renderManager();

        if (!silent) {
            toastr.success(normalizedFolderId ? `Moved to ${getFolderPathLabel(normalizedFolderId)}.` : 'Moved to No Folder.');
        }
    } catch (error) {
        console.error('[Lorebook Manager] Failed to move lorebook', error);
        toastr.error('Failed to move the lorebook.');
    }
}

async function ensureStableLorebookId(apiName) {
    const record = findLorebook(apiName);
    if (record?.bookId) {
        return record.bookId;
    }

    const meta = await mutateLorebookMeta(apiName, current => current);
    applyLorebookMetaToState(apiName, meta);
    return meta.bookId;
}

// Per-lorebook write queue to serialize load → mutate → save round-trips.
// Without this, parallel callers (bulk-move, auto-refresh, cover upload, etc.)
// could race and silently clobber each other's metadata.
const _metaWriteQueues = new Map();

async function mutateLorebookMeta(apiName, updater) {
    const previous = _metaWriteQueues.get(apiName) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => _mutateLorebookMetaImmediate(apiName, updater));
    _metaWriteQueues.set(apiName, next);

    try {
        return await next;
    } finally {
        // Drop the queue head once the chain has fully drained.
        if (_metaWriteQueues.get(apiName) === next) {
            _metaWriteQueues.delete(apiName);
        }
    }
}

async function _mutateLorebookMetaImmediate(apiName, updater) {
    const data = await loadWorldInfo(apiName);
    if (!isObject(data)) {
        throw new Error(`Lorebook "${apiName}" could not be loaded.`);
    }

    if (!isObject(data.extensions)) {
        data.extensions = {};
    }

    const existing = getLorebookMetaFromData(data);
    const draft = {
        bookId: existing.bookId || getContext().uuidv4(),
        folderId: existing.folderId || '',
        coverPath: existing.coverPath || '',
    };

    const next = updater ? updater({ ...draft }) : draft;
    const cleaned = cleanLorebookMeta(next);

    if (cleaned) {
        data.extensions[LOREBOOK_META_KEY] = cleaned;
    } else {
        delete data.extensions[LOREBOOK_META_KEY];
    }

    await saveWorldInfo(apiName, data, true);
    return cleaned || {};
}

async function clearLorebookCover(apiName) {
    const record = findLorebook(apiName);
    if (!record?.coverPath) {
        return;
    }

    const confirmed = await Popup.show.confirm(`Remove the cover for "${escapeHtml(record.displayName)}"?`, '');
    if (!confirmed) {
        return;
    }

    try {
        await deleteCoverAsset(record.coverPath);
    } catch (error) {
        console.warn('[Lorebook Manager] Failed to delete cover asset before clearing metadata', error);
    }

    try {
        const meta = await mutateLorebookMeta(apiName, current => ({
            ...current,
            coverPath: '',
        }));

        applyLorebookMetaToState(apiName, meta);
        renderManager();
        toastr.success('Lorebook cover removed.');
    } catch (error) {
        console.error('[Lorebook Manager] Failed to clear lorebook cover metadata', error);
        toastr.error('Failed to remove the lorebook cover.');
    }
}

async function deleteCoverAsset(coverPath) {
    if (!coverPath) {
        return;
    }

    if (!isSafeCoverPath(coverPath)) {
        console.warn('[Lorebook Manager] Refusing to delete cover asset with suspicious path', coverPath);
        return;
    }

    const response = await fetch('/api/images/delete', {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify({ path: coverPath }),
    });

    if (!response.ok) {
        throw new Error(`Failed to delete cover asset (${response.status})`);
    }
}

async function deleteLorebookWithCover(apiName) {
    const record = findLorebook(apiName);
    if (!record) {
        return;
    }

    const confirmed = await Popup.show.confirm(`Delete lorebook "${escapeHtml(record.displayName)}"?`, 'This also removes its manager cover if one is set.');
    if (!confirmed) {
        return;
    }

    if (record.coverPath) {
        try {
            await deleteCoverAsset(record.coverPath);
        } catch (error) {
            console.warn('[Lorebook Manager] Failed to delete lorebook cover asset', error);
        }
    }

    const deleted = await deleteWorldInfo(apiName);
    if (!deleted) {
        toastr.error('Failed to delete the lorebook.');
        return;
    }

    delete state.entryCounts[apiName];
    state.selectedBooks.delete(apiName);

    await refreshLorebooks({ showLoader: false });
    toastr.success(`Deleted "${escapeHtml(record.displayName)}".`);
}

function scheduleRefresh(delay = 120) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
        if (!state.isOpen) {
            return;
        }

        refreshLorebooks({ showLoader: false });
    }, delay);
}

function getWorldToolbarRow() {
    const deleteButton = document.getElementById('world_popup_delete');
    if (deleteButton?.parentElement instanceof HTMLElement) {
        return deleteButton.parentElement;
    }

    const editorSelect = document.getElementById('world_editor_select');
    if (editorSelect?.parentElement instanceof HTMLElement) {
        return editorSelect.parentElement;
    }

    const toolbarRow = document.querySelector('#world_popup .flex-container');
    return toolbarRow instanceof HTMLElement ? toolbarRow : null;
}

function scheduleToolbarSync() {
    if (state.toolbarSyncFrame) {
        return;
    }

    state.toolbarSyncFrame = requestAnimationFrame(() => {
        state.toolbarSyncFrame = 0;
        injectManagerButton();
        startWorldListObserver();
    });
}

function placeToolbarButton(toolbarRow, button, beforeNode = null) {
    if (!(toolbarRow instanceof HTMLElement) || !(button instanceof HTMLElement)) {
        return;
    }

    if (beforeNode instanceof HTMLElement) {
        if (button.parentElement === toolbarRow && button.nextElementSibling === beforeNode) {
            return;
        }

        toolbarRow.insertBefore(button, beforeNode);
        return;
    }

    if (button.parentElement === toolbarRow && toolbarRow.lastElementChild === button) {
        return;
    }

    toolbarRow.appendChild(button);
}

function injectManagerButton() {
    const toolbarRow = getWorldToolbarRow();
    if (!toolbarRow) {
        return;
    }

    const deleteButton = document.getElementById('world_popup_delete');
    const coverButton = getOrCreateToolbarButton({
        id: 'lorebook_cover_button',
        title: 'Set a lorebook cover',
        iconHtml: '<i class="fa-solid fa-image"></i>',
        onClick: onCurrentLorebookCoverClick,
    });
    const managerButton = getOrCreateToolbarButton({
        id: 'lorebook_manager_button',
        title: 'Open Lorebook Manager',
        iconHtml: '<i class="fa-solid fa-folder-tree"></i><span>Manager</span>',
        onClick: openManager,
    });

    if (deleteButton?.parentElement === toolbarRow) {
        placeToolbarButton(toolbarRow, managerButton, deleteButton);
        placeToolbarButton(toolbarRow, coverButton, managerButton);
    } else {
        placeToolbarButton(toolbarRow, coverButton);
        placeToolbarButton(toolbarRow, managerButton);
    }

    updateWorldToolbarButtons();
}

function getOrCreateToolbarButton({ id, title, iconHtml, onClick }) {
    let button = document.getElementById(id);
    if (button) {
        return button;
    }

    button = document.createElement('div');
    button.id = id;
    button.className = 'menu_button menu_button_icon interactable';
    button.title = title;
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', title);
    button.setAttribute('tabindex', '0');
    button.innerHTML = iconHtml;
    button.addEventListener('click', onClick);
    return button;
}

function startButtonObserver() {
    if (state.buttonObserver) {
        return;
    }

    state.buttonObserver = new MutationObserver(() => {
        scheduleToolbarSync();
        hijackWorldInfoDrawer();
    });

    // Watch only the regions that actually host the WI drawer / popup / nav,
    // instead of the entire body. This avoids firing on every chat message.
    const targets = [
        document.getElementById('WorldInfo'),
        document.getElementById('world_popup'),
        document.getElementById('top-settings-holder'),
        document.getElementById('right-nav-panel'),
        document.getElementById('sheld'),
    ].filter(node => node instanceof HTMLElement);

    if (targets.length === 0) {
        // Fall back to body but only watch direct children so it stays cheap.
        state.buttonObserver.observe(document.body, { childList: true, subtree: false });
    } else {
        targets.forEach(target => state.buttonObserver.observe(target, { childList: true, subtree: true }));
    }

    scheduleToolbarSync();
}

function startWorldListObserver() {
    const worldSelect = document.getElementById('world_editor_select');
    if (!(worldSelect instanceof HTMLElement)) {
        return;
    }

    if (state.worldListElement === worldSelect) {
        return;
    }

    state.worldListObserver?.disconnect();
    state.worldListElement = worldSelect;

    if (!worldSelect.dataset.lmbBound) {
        worldSelect.addEventListener('change', updateWorldToolbarButtons);
        worldSelect.dataset.lmbBound = 'true';
    }

    state.worldListObserver = new MutationObserver(() => {
        scheduleRefresh();
        updateWorldToolbarButtons();
    });

    state.worldListObserver.observe(worldSelect, { childList: true, subtree: true });
}

function handleWorldInfoUpdated(apiName, data) {
    const entryCount = getLorebookEntryCount(data);
    state.entryCounts[apiName] = entryCount;

    const meta = getLorebookMetaFromData(data);
    const existing = findLorebook(apiName);
    if (existing) {
        applyLorebookMetaToState(apiName, meta);
        state.lorebooks = state.lorebooks.map(record => record.apiName === apiName
            ? { ...record, entryCount }
            : record);
        updateWorldToolbarButtons();
        renderManager();
    } else {
        scheduleRefresh();
    }
}

function getCurrentEditorLorebookName() {
    const select = document.getElementById('world_editor_select');
    if (!(select instanceof HTMLSelectElement)) {
        return '';
    }

    const selectedOption = select.options[select.selectedIndex];
    if (!selectedOption || selectedOption.value === '') {
        return '';
    }

    return selectedOption.textContent?.trim() || '';
}

function updateWorldToolbarButtons() {
    const coverButton = document.getElementById('lorebook_cover_button');
    if (!coverButton) {
        return;
    }

    const apiName = getCurrentEditorLorebookName();
    const record = apiName ? findLorebook(apiName) : null;
    const hasCover = Boolean(record?.coverPath);
    const title = getCoverButtonTitle(apiName, record, hasCover);

    coverButton.title = title;
    coverButton.setAttribute('aria-label', title);
    coverButton.classList.toggle('is-disabled', !apiName);
    coverButton.classList.toggle('has-cover', hasCover);
}

function getCoverButtonTitle(apiName, record, hasCover) {
    if (!apiName) {
        return 'Open a lorebook to set a cover.';
    }

    const displayName = record?.displayName || apiName;
    return hasCover
        ? `Set or replace the cover for "${displayName}". Shift-click to remove the current cover.`
        : `Set a cover for "${displayName}".`;
}

async function onCurrentLorebookCoverClick(event) {
    const apiName = getCurrentEditorLorebookName();
    if (!apiName) {
        toastr.info('Open a lorebook first.');
        return;
    }

    const record = findLorebook(apiName);
    if ((event.shiftKey || event.altKey) && record?.coverPath) {
        await clearLorebookCover(apiName);
        updateWorldToolbarButtons();
        return;
    }

    await ensureManagerDom();
    state.pendingCoverTarget = apiName;
    state.dom.coverInput.click();
}

function collapseWorldInfoDrawer() {
    const drawer = document.getElementById('WorldInfo');
    if (drawer?.classList.contains('closedDrawer')) {
        return;
    }

    document.getElementById('WIDrawerIcon')?.click();
}


// ══════════════════════════════════════════════════════════════
// MULTI-SELECT
// ══════════════════════════════════════════════════════════════

function isSelectMode() {
    return state.selectedBooks.size > 0;
}

function toggleBookSelection(apiName) {
    if (state.selectedBooks.has(apiName)) {
        state.selectedBooks.delete(apiName);
    } else {
        state.selectedBooks.add(apiName);
    }
    updateSelectUI();
}

function clearSelection() {
    state.selectedBooks.clear();
    updateSelectUI();
}

function updateSelectUI() {
    const count = state.selectedBooks.size;
    const hasSelection = count > 0;

    state.dom.selectBar?.classList.toggle('lmb_hidden', !hasSelection);
    state.dom.modal?.classList.toggle('is-selecting', hasSelection);

    if (state.dom.selectCount) {
        state.dom.selectCount.textContent = `${count} selected`;
    }

    state.dom.grid?.querySelectorAll('.lmb_card').forEach(card => {
        const name = card.dataset.bookName;
        const selected = state.selectedBooks.has(name);
        card.classList.toggle('is-selected', selected);

        const cb = card.querySelector('.lmb_card_checkbox');
        if (cb) {
            const icon = cb.querySelector('i');
            if (icon) {
                icon.className = selected
                    ? 'fa-solid fa-check'
                    : 'fa-regular fa-square';
            }
        }
    });
}

function onGridCheckboxClick(event) {
    // Any explicit action control (pin star, link, buttons, selects, inputs)
    // handles its own click in onLorebookGridClick — never let it also toggle
    // the selection checkbox. This includes the favorite star, which lives
    // inside the cover.
    if (event.target.closest('[data-lmb-book-action], button, select, input, a')) return;

    const card = event.target.closest('.lmb_card');
    if (!card) return;
    const apiName = card.dataset.bookName;
    if (!apiName) return;

    const clickedCover = event.target.closest('.lmb_card_cover');
    const clickedCheckbox = event.target.closest('.lmb_card_checkbox');
    const clickedBody = event.target.closest('.lmb_card_body');
    if (!clickedCover && !clickedCheckbox && !clickedBody) return;

    // stopImmediatePropagation (not just stopPropagation) so that no sibling
    // 'click' listener bound to the same grid element can also act on this
    // event — both onLorebookGridClick and onGridCheckboxClick live here.
    event.stopImmediatePropagation();
    event.preventDefault();

    const now = Date.now();
    if (apiName === _lastCardTapName && (now - _lastCardTapTime) < DOUBLE_TAP_MS) {
        _lastCardTapTime = 0;
        _lastCardTapName = '';
        closeManager();
        openWorldInfoEditor(apiName);
        return;
    }

    _lastCardTapTime = now;
    _lastCardTapName = apiName;
    toggleBookSelection(apiName);
}

function onGridDoubleClick(event) {
    const card = event.target.closest('.lmb_card');
    if (!card) return;
    const clickedCover = event.target.closest('.lmb_card_cover');
    const clickedBody = event.target.closest('.lmb_card_body');
    if (!clickedCover && !clickedBody) return;
    const apiName = card.dataset.bookName;
    if (!apiName) return;
    event.stopPropagation();
    closeManager();
    openWorldInfoEditor(apiName);
}

function onSelectAllClick() {
    const visibleOnPage = getLorebooksOnCurrentPage(getVisibleLorebooks());
    visibleOnPage.forEach(record => state.selectedBooks.add(record.apiName));
    updateSelectUI();
}

function onDeselectAllClick() {
    clearSelection();
}

async function onBulkDeleteClick() {
    const count = state.selectedBooks.size;
    if (count === 0) return;

    const confirmed = await Popup.show.confirm(
        `Delete ${count} lorebook(s)?`,
        'This will also remove their covers if set. This action cannot be undone.',
    );
    if (!confirmed) return;

    const toDelete = [...state.selectedBooks];
    let deleted = 0;
    let failed = 0;

    for (const apiName of toDelete) {
        const record = findLorebook(apiName);
        if (!record) continue;

        if (record.coverPath) {
            try {
                await deleteCoverAsset(record.coverPath);
            } catch (err) {
                console.warn('[Lorebook Manager] Failed to delete cover for', apiName, err);
            }
        }

        const ok = await deleteWorldInfo(apiName);
        if (ok) {
            delete state.entryCounts[apiName];
            deleted++;
        } else {
            failed++;
        }
    }

    clearSelection();
    await refreshLorebooks({ showLoader: false });

    if (deleted > 0) {
        toastr.success(`Deleted ${deleted} lorebook(s).`);
    }
    if (failed > 0) {
        toastr.error(`Failed to delete ${failed} lorebook(s).`);
    }
}

async function onBulkMoveClick() {
    const count = state.selectedBooks.size;
    if (count === 0) return;

    const folderOptions = buildFolderOptions();
    const optionsHtml = folderOptions
        .map(opt => `<option value="${escapeAttr(opt.value)}">${escapeHtml(opt.textContent)}</option>`)
        .join('');

    const html = `
        <div style="margin: 8px 0;">
            <label style="display:block; margin-bottom:6px;">Move ${escapeHtml(count)} lorebook(s) to:</label>
            <select id="lmb_bulk_folder_target" class="text_pole" style="width:100%;">
                <option value="">No Folder</option>
                ${optionsHtml}
            </select>
        </div>
    `;

    const result = await Popup.show.confirm('Move lorebooks', html);
    if (!result) return;

    const targetSelect = document.getElementById('lmb_bulk_folder_target');
    const folderId = targetSelect?.value || null;

    const toMove = [...state.selectedBooks];
    for (const apiName of toMove) {
        await moveLorebookToFolder(apiName, folderId, { silent: true });
    }

    clearSelection();
    renderManager();

    const label = folderId ? getFolderPathLabel(folderId) : 'No Folder';
    toastr.success(`Moved ${toMove.length} lorebook(s) to ${escapeHtml(label)}.`);
}

// ── Sidebar toggle (mobile) ──

function onSidebarToggleClick(event) {
    const sidebar = state.dom.sidebar;
    const toggle = state.dom.sidebarToggle;
    if (!sidebar || !toggle) return;

    event?.stopPropagation();

    const isCollapsed = sidebar.classList.toggle('is-collapsed');
    toggle.classList.toggle('is-open', !isCollapsed);
}

function onSidebarOutsideClick(event) {
    const sidebar = state.dom.sidebar;
    const toggle = state.dom.sidebarToggle;
    if (!sidebar || !toggle) return;

    // Only relevant while the sidebar is expanded as a mobile overlay.
    if (sidebar.classList.contains('is-collapsed')) return;
    if (toggle.offsetParent === null) return;

    if (sidebar.contains(event.target) || toggle.contains(event.target)) return;

    collapseMobileSidebar();
}

// Auto-collapse the sidebar after a folder/tag pick on phones, where the
// sidebar is shown as an overlay and would otherwise stay on top of the grid.
function collapseMobileSidebar() {
    const sidebar = state.dom.sidebar;
    const toggle = state.dom.sidebarToggle;
    if (!sidebar || !toggle) return;

    // The toggle button is only visible on mobile/narrow layouts. If it has
    // zero size we're on desktop and there's nothing to collapse.
    if (toggle.offsetParent === null) return;

    if (!sidebar.classList.contains('is-collapsed')) {
        sidebar.classList.add('is-collapsed');
        toggle.classList.remove('is-open');
    }
}

// ══════════════════════════════════════════════════════════════
// TOUCH MODULE
// ══════════════════════════════════════════════════════════════

const touch = {
    active: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    dragCard: null,
    dragName: '',
    ghost: null,
    longPressTimer: null,
    longPressTriggered: false,
    scrollLocked: false,
    LONG_PRESS_MS: 400,
    DRAG_THRESHOLD: 10,
};

function isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function getTouchPos(e) {
    const t = e.touches?.[0] || e.changedTouches?.[0];
    return t ? { x: t.clientX, y: t.clientY } : { x: 0, y: 0 };
}

function distanceMoved(pos) {
    return Math.hypot(pos.x - touch.startX, pos.y - touch.startY);
}

function createDragGhost(card) {
    const ghost = document.createElement('div');
    ghost.className = 'lmb_drag_ghost';
    const title = card.querySelector('.lmb_card_title')?.textContent || '?';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-book-atlas';
    ghost.appendChild(icon);
    ghost.appendChild(document.createTextNode(' ' + title));
    ghost.style.cssText = `
        position: fixed; z-index: 9999; padding: 8px 14px;
        border-radius: 10px; background: var(--lmb-surface-strong, rgba(30,30,34,0.95));
        border: 1px solid var(--lmb-accent, #e18a24); color: var(--lmb-text, #f2f0eb);
        font-size: 0.88rem; pointer-events: none; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        display: flex; align-items: center; gap: 8px; max-width: 200px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        opacity: 0.92; transform: translate(-50%, -120%);
    `;
    document.body.appendChild(ghost);
    return ghost;
}

function positionGhost(x, y) {
    if (!touch.ghost) return;
    touch.ghost.style.left = `${x}px`;
    touch.ghost.style.top = `${y}px`;
}

function removeGhost() {
    touch.ghost?.remove();
    touch.ghost = null;
}

function getDropTargetAt(x, y) {
    if (touch.ghost) touch.ghost.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (touch.ghost) touch.ghost.style.display = '';
    if (!el) return null;
    return el.closest('[data-lmb-drop-target]');
}

function highlightDropTarget(x, y) {
    clearDropTargetStyles();
    const target = getDropTargetAt(x, y);
    if (target) {
        target.classList.add('is-drop-target');
    }
    return target;
}

function startLongPressTimer(card, apiName) {
    cancelLongPress();
    touch.longPressTriggered = false;
    touch.longPressTimer = setTimeout(() => {
        touch.longPressTriggered = true;
        if (navigator.vibrate) navigator.vibrate(30);
        toggleBookSelection(apiName);
    }, touch.LONG_PRESS_MS);
}

function cancelLongPress() {
    if (touch.longPressTimer) {
        clearTimeout(touch.longPressTimer);
        touch.longPressTimer = null;
    }
}

function onGridTouchStart(e) {
    const card = e.target.closest('.lmb_card');
    if (!card) return;

    const interactive = e.target.closest('button, select, input, a, .lmb_card_checkbox');
    if (interactive) return;

    const apiName = card.dataset.bookName || '';
    if (!apiName) return;

    const pos = getTouchPos(e);
    touch.startX = pos.x;
    touch.startY = pos.y;
    touch.currentX = pos.x;
    touch.currentY = pos.y;
    touch.dragCard = card;
    touch.dragName = apiName;
    touch.active = false;
    touch.scrollLocked = false;

    if (!isSelectMode()) {
        startLongPressTimer(card, apiName);
    }
}

function onGridTouchMove(e) {
    if (!touch.dragCard) return;

    const pos = getTouchPos(e);
    touch.currentX = pos.x;
    touch.currentY = pos.y;
    const dist = distanceMoved(pos);

    if (dist > touch.DRAG_THRESHOLD) {
        cancelLongPress();
    }

    if (!touch.active && dist > touch.DRAG_THRESHOLD && !isSelectMode() && touch.longPressTriggered) {
        touch.active = true;
        touch.scrollLocked = true;
        touch.dragCard.classList.add('is-dragging');
        state.dom.modal?.classList.add('is-touch-dragging');
        touch.ghost = createDragGhost(touch.dragCard);
        positionGhost(pos.x, pos.y);
    }

    if (touch.active) {
        e.preventDefault();
        positionGhost(pos.x, pos.y);
        highlightDropTarget(pos.x, pos.y);

        // Auto-scroll near edges
        const grid = state.dom.grid;
        if (grid) {
            const rect = grid.getBoundingClientRect();
            const edge = 50, speed = 6;
            if (pos.y < rect.top + edge) grid.scrollTop -= speed;
            else if (pos.y > rect.bottom - edge) grid.scrollTop += speed;
        }
        const tree = state.dom.folderTree;
        if (tree) {
            const treeRect = tree.getBoundingClientRect();
            const edge = 50, speed = 6;
            if (pos.y < treeRect.top + edge && pos.y > treeRect.top - 20) tree.scrollTop -= speed;
            else if (pos.y > treeRect.bottom - edge && pos.y < treeRect.bottom + 20) tree.scrollTop += speed;
        }
    }
}

function onGridTouchEnd(e) {
    cancelLongPress();

    if (touch.active) {
        const pos = getTouchPos(e);
        const target = getDropTargetAt(pos.x, pos.y);

        if (target && touch.dragName) {
            const rawTarget = target.dataset.lmbDropTarget;
            const folderId = rawTarget === SPECIAL_FOLDERS.UNFILED ? null : rawTarget;
            moveLorebookToFolder(touch.dragName, folderId);
        }

        touch.dragCard?.classList.remove('is-dragging');
        state.dom.modal?.classList.remove('is-touch-dragging');
        clearDropTargetStyles();
        removeGhost();
    }

    touch.active = false;
    touch.dragCard = null;
    touch.dragName = '';
    touch.scrollLocked = false;
    touch.longPressTriggered = false;
}

function bindTouchEvents() {
    if (!isTouchDevice()) return;

    const grid = state.dom.grid;
    const tree = state.dom.folderTree;

    if (grid) {
        grid.addEventListener('touchstart', onGridTouchStart, { passive: true });
        grid.addEventListener('touchmove', onGridTouchMove, { passive: false });
        grid.addEventListener('touchend', onGridTouchEnd, { passive: true });
        grid.addEventListener('touchcancel', onGridTouchEnd, { passive: true });
    }

    if (tree) {
        tree.addEventListener('touchmove', (e) => {
            if (touch.active) e.preventDefault();
        }, { passive: false });
    }
}

function injectTouchStyles() {
    if (document.getElementById('lmb-touch-styles')) return;

    const style = document.createElement('style');
    style.id = 'lmb-touch-styles';
    style.textContent = `
        .lmb_modal.is-touch-dragging {
            user-select: none;
            -webkit-user-select: none;
        }
        .lmb_modal.is-touch-dragging .lmb_grid {
            overflow: hidden !important;
        }
        .lmb_card:active {
            transform: scale(0.98);
            transition: transform 0.1s ease;
        }
        .lmb_card.is-dragging {
            opacity: 0.4;
            transform: scale(0.95);
        }
        @media (pointer: coarse) {
            .lmb_folder_row, .lmb_virtual_row { min-height: 48px; }
            .lmb_folder_button, .lmb_virtual_button { min-height: 48px; padding: 12px; }
            .lmb_folder_toggle, .lmb_folder_tool { width: 42px; height: 42px; }
            .lmb_panel { overscroll-behavior: contain; touch-action: pan-y; }
            .lmb_grid { overscroll-behavior: contain; }
            .lmb_folder_tree { overscroll-behavior: contain; }
            .lmb_folder_target.is-drop-target {
                background: color-mix(in srgb, var(--lmb-accent) 30%, transparent 70%) !important;
                outline: 2px solid var(--lmb-accent);
                outline-offset: -2px;
            }
        }
    `;
    document.head.appendChild(style);
}


// ══════════════════════════════════════════════════════════════
// DRAWER HIJACK — open Manager instead of default WI drawer
// ══════════════════════════════════════════════════════════════

function hijackWorldInfoDrawer() {
    const settings = getManagerSettings();
    if (!settings.openManagerOnDrawer) return;

    // Method 1: Intercept the drawer icon click
    const drawerIcon = document.getElementById('WIDrawerIcon');
    if (drawerIcon && !drawerIcon.dataset.lmbHijacked) {
        drawerIcon.dataset.lmbHijacked = 'true';

        drawerIcon.addEventListener('click', (e) => {
            const settings = getManagerSettings();
            if (!settings.openManagerOnDrawer) return;

            // If the manager is already open, a repeat click should close it.
            if (state.isOpen) {
                e.stopImmediatePropagation();
                e.preventDefault();
                closeManager();
                return;
            }

            // Only hijack if drawer is currently closed (= user wants to open it)
            const drawer = document.getElementById('WorldInfo');
            const isClosed = drawer?.classList.contains('closedDrawer');

            if (isClosed) {
                e.stopImmediatePropagation();
                e.preventDefault();
                openManager();
            }
            // If drawer is open, let default behavior close it
        }, true); // capture phase — fires before ST's own handler
    }

    // Method 2: Also watch for the World Info nav button (mobile layout)
    const wiButton = document.querySelector('[data-page="world_info"]');
    if (wiButton && !wiButton.dataset.lmbHijacked) {
        wiButton.dataset.lmbHijacked = 'true';

        wiButton.addEventListener('click', (e) => {
            const settings = getManagerSettings();
            if (!settings.openManagerOnDrawer) return;

            e.stopImmediatePropagation();
            e.preventDefault();

            // Toggle: a repeat click on the WI nav button closes the manager.
            if (state.isOpen) {
                closeManager();
            } else {
                openManager();
            }
        }, true);
    }

    // Method 3: Close the manager when any *other* top-bar drawer button is
    // clicked (e.g. user opens Extensions, Persona, AI Response Config, …).
    bindTopBarCloseHandlers();
}

// When the manager is open and the user clicks a different top-bar drawer
// icon, close the manager so it doesn't stay floating over the new panel.
function bindTopBarCloseHandlers() {
    const topBar = document.getElementById('top-settings-holder');
    if (!topBar || topBar.dataset.lmbTopBarBound) return;
    topBar.dataset.lmbTopBarBound = 'true';

    topBar.addEventListener('click', (e) => {
        if (!state.isOpen) return;

        // The World Info icon has its own dedicated handler above.
        if (e.target.closest('#WIDrawerIcon')) return;

        // Only react to actual drawer/menu buttons in the top bar.
        const button = e.target.closest('.drawer-icon, .drawer-toggle');
        if (!button) return;

        closeManager();
    }, true); // capture phase, before ST opens the other drawer
}



// ══════════════════════════════════════════════════════════════
// FEATURE: DUPLICATE LOREBOOK
// ══════════════════════════════════════════════════════════════

async function duplicateLorebook(apiName) {
    const record = findLorebook(apiName);
    if (!record) {
        toastr.error('Lorebook not found.');
        return;
    }

    const defaultName = getFreeWorldName(`${record.displayName} — Copy`);
    const newName = await Popup.show.input(
        'Duplicate Lorebook',
        `Enter a name for the clone of "${escapeHtml(record.displayName)}":`,
        defaultName,
    );

    if (!newName || !newName.trim()) return;

    try {
        setLoading(true);

        const sourceData = await loadWorldInfo(record.apiName);
        if (!sourceData) {
            toastr.error('Failed to load the source lorebook.');
            return;
        }

        const created = await createNewWorldInfo(newName.trim(), { interactive: false });
        if (!created) {
            toastr.error('Failed to create the new lorebook.');
            return;
        }

        const newData = await loadWorldInfo(newName.trim());
        if (!newData) {
            toastr.error('Failed to load the newly created lorebook.');
            return;
        }

        newData.entries = structuredClone(sourceData.entries || {});

        const topLevelKeys = [
            'recursive_scanning', 'scan_depth', 'case_sensitive',
            'match_whole_words', 'use_group_scoring', 'overflow_alert',
        ];
        for (const key of topLevelKeys) {
            if (key in sourceData) {
                newData[key] = structuredClone(sourceData[key]);
            }
        }

        if (isObject(sourceData.extensions)) {
            newData.extensions = structuredClone(sourceData.extensions);
            delete newData.extensions[LOREBOOK_META_KEY];
        }

        await saveWorldInfo(newName.trim(), newData, true);

        if (record.folderId) {
            await moveLorebookToFolder(newName.trim(), record.folderId, { silent: true });
        }

        const settings = getManagerSettings();
        if (settings.lorebookTags?.[apiName]?.length) {
            if (!isObject(settings.lorebookTags)) settings.lorebookTags = {};
            settings.lorebookTags[newName.trim()] = [...settings.lorebookTags[apiName]];
            saveManagerSettings();
        }

        await refreshLorebooks({ showLoader: false });
        toastr.success(`Duplicated "${escapeHtml(record.displayName)}" → "${escapeHtml(newName.trim())}".`);
    } catch (error) {
        console.error('[Lorebook Manager] Duplicate failed', error);
        toastr.error('Failed to duplicate the lorebook.');
    } finally {
        setLoading(false);
    }
}


// ══════════════════════════════════════════════════════════════
// FEATURE: STATISTICS POPUP
// ══════════════════════════════════════════════════════════════

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    // Same as escapeHtml — covers " and ' which are critical for attribute contexts.
    return escapeHtml(str);
}

async function showLorebookStats(apiName) {
    const record = findLorebook(apiName);
    if (!record) {
        toastr.error('Lorebook not found.');
        return;
    }

    try {
        const data = await loadWorldInfo(record.apiName);
        if (!data) {
            toastr.error('Failed to load lorebook data.');
            return;
        }

        const entries = isObject(data.entries) ? Object.values(data.entries) : [];
        const entryCount = entries.length;

        let totalChars = 0;
        let totalKeywords = 0;
        let enabledCount = 0;
        let disabledCount = 0;
        let constantCount = 0;

        for (const entry of entries) {
            const content = String(entry.content || '');
            const keys = Array.isArray(entry.key) ? entry.key : [];
            const secondaryKeys = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];

            totalChars += content.length;
            totalKeywords += keys.length + secondaryKeys.length;

            if (entry.constant) constantCount++;
            if (entry.disable === true || entry.enabled === false) {
                disabledCount++;
            } else {
                enabledCount++;
            }
        }

        const approxTokens = Math.round(totalChars / 3.5);
        const sizeKB = (new TextEncoder().encode(JSON.stringify(data)).length / 1024).toFixed(1);

        const tags = getLorebookTags(apiName);
        const tagsLine = tags.length
            ? tags.map(t => `<span class="lmb_stat_tag">${escapeHtml(t)}</span>`).join(' ')
            : '<i>No tags</i>';

        const isActive = state.activeLorebookNames.has(record.apiName);
        const folderLabel = getFolderPathLabel(record.folderId);

        const html = `
        <div class="lmb_stats_popup">
            <div class="lmb_stats_grid">
                <div class="lmb_stat_card">
                    <div class="lmb_stat_icon"><i class="fa-solid fa-list"></i></div>
                    <div class="lmb_stat_value">${entryCount}</div>
                    <div class="lmb_stat_label">Entries</div>
                </div>
                <div class="lmb_stat_card">
                    <div class="lmb_stat_icon"><i class="fa-solid fa-check-circle"></i></div>
                    <div class="lmb_stat_value">${enabledCount}</div>
                    <div class="lmb_stat_label">Enabled</div>
                </div>
                <div class="lmb_stat_card">
                    <div class="lmb_stat_icon"><i class="fa-solid fa-ban"></i></div>
                    <div class="lmb_stat_value">${disabledCount}</div>
                    <div class="lmb_stat_label">Disabled</div>
                </div>
                <div class="lmb_stat_card">
                    <div class="lmb_stat_icon"><i class="fa-solid fa-thumbtack"></i></div>
                    <div class="lmb_stat_value">${constantCount}</div>
                    <div class="lmb_stat_label">Constant</div>
                </div>
                <div class="lmb_stat_card">
                    <div class="lmb_stat_icon"><i class="fa-solid fa-coins"></i></div>
                    <div class="lmb_stat_value">~${approxTokens.toLocaleString()}</div>
                    <div class="lmb_stat_label">Tokens (est.)</div>
                </div>
                <div class="lmb_stat_card">
                    <div class="lmb_stat_icon"><i class="fa-solid fa-key"></i></div>
                    <div class="lmb_stat_value">${totalKeywords}</div>
                    <div class="lmb_stat_label">Keywords</div>
                </div>
                <div class="lmb_stat_card">
                    <div class="lmb_stat_icon"><i class="fa-solid fa-weight-hanging"></i></div>
                    <div class="lmb_stat_value">${sizeKB} KB</div>
                    <div class="lmb_stat_label">File Size</div>
                </div>
                <div class="lmb_stat_card">
                    <div class="lmb_stat_icon"><i class="fa-solid fa-${isActive ? 'bolt' : 'circle-minus'}"></i></div>
                    <div class="lmb_stat_value">${isActive ? 'Yes' : 'No'}</div>
                    <div class="lmb_stat_label">Active</div>
                </div>
            </div>
            <div class="lmb_stats_meta">
                <p><i class="fa-solid fa-folder"></i> <strong>Folder:</strong> ${escapeHtml(folderLabel)}</p>
                <p><i class="fa-solid fa-tags"></i> <strong>Tags:</strong> ${tagsLine}</p>
                <p><i class="fa-solid fa-font"></i> <strong>Characters:</strong> ${totalChars.toLocaleString()}</p>
            </div>
        </div>`;

        await Popup.show.text(`Stats: ${escapeHtml(record.displayName)}`, html);
    } catch (error) {
        console.error('[Lorebook Manager] Stats failed', error);
        toastr.error('Failed to load lorebook statistics.');
    }
}


// ══════════════════════════════════════════════════════════════
// FEATURE: CHARACTER LOREBOOK LINKING
// ══════════════════════════════════════════════════════════════

/**
 * Returns an array of { charName, charIndex, type: 'primary'|'extra' } for every
 * character that has this lorebook bound (either as primary or auxiliary).
 */
function getCharacterBindingsForLorebook(apiName) {
    const context = getContext();
    const characters = context.characters || [];
    const bindings = [];

    for (let i = 0; i < characters.length; i++) {
        const char = characters[i];
        if (!char) continue;

        const charName = char.name || char.avatar || `Character ${i}`;

        // Check primary lorebook
        const primaryLorebook = char.data?.extensions?.world;
        if (typeof primaryLorebook === 'string' && primaryLorebook.trim() === apiName) {
            bindings.push({ charName, charIndex: i, avatar: char.avatar, type: 'primary' });
        }

        // Check auxiliary lorebooks
        const extras = getCharacterExtraLorebooks(char);
        if (extras.includes(apiName)) {
            bindings.push({ charName, charIndex: i, avatar: char.avatar, type: 'extra' });
        }
    }

    return bindings;
}

/**
 * Returns true if the given character is the one currently open in the
 * character editor / active in the chat. Primary lorebook binding only works
 * for the current character because SillyTavern's charUpdatePrimaryWorld()
 * writes through the #character_world DOM element and createOrEditCharacter().
 */
function isCurrentCharacter(character) {
    if (!character) return false;
    const context = getContext();
    const current = context.characters?.[context.characterId];
    if (!current) return false;
    return current.avatar === character.avatar;
}

/**
 * Sets or clears the PRIMARY lorebook for a character.
 *
 * Uses SillyTavern's own charUpdatePrimaryWorld(), which updates the
 * #character_world selector and persists through createOrEditCharacter().
 * This only works for the character currently open in the editor.
 */
async function setCharacterPrimaryLorebook(character, lorebookName) {
    if (!character) throw new Error('No character provided');

    if (!isCurrentCharacter(character)) {
        throw new Error('NOT_CURRENT_CHARACTER');
    }

    // #character_world is a hidden input (not a <select>), so charUpdatePrimaryWorld()
    // can set its value regardless of whether the book is in any dropdown.
    await charUpdatePrimaryWorld(lorebookName || '');

    // Keep the in-memory representation in sync for immediate re-render.
    if (!character.data) character.data = {};
    if (!character.data.extensions) character.data.extensions = {};
    character.data.extensions.world = lorebookName || '';
}

/**
 * Adds an auxiliary (extra) lorebook for a character.
 * Uses SillyTavern's charUpdateAddAuxWorld(), which writes world_info.charLore
 * and saves settings. Works for any character by avatar key.
 */
function addCharacterExtraLorebook(character, lorebookName) {
    const avatarKey = character?.avatar;
    if (!avatarKey) throw new Error('Character has no avatar key');

    charUpdateAddAuxWorld(avatarKey, lorebookName);
}

/**
 * Removes an auxiliary (extra) lorebook for a character.
 * Uses SillyTavern's charSetAuxWorlds() with the lorebook filtered out, which
 * cleans up empty entries and saves settings.
 */
function removeCharacterExtraLorebook(character, lorebookName) {
    const avatarKey = character?.avatar;
    if (!avatarKey) return;

    const fileName = getCharaFilename(null, { manualAvatarKey: avatarKey });
    if (!fileName) return;

    const remaining = getCharacterExtraLorebooks(character).filter(name => name !== lorebookName);
    charSetAuxWorlds(fileName, remaining);
}

/**
 * Opens a popup to link/unlink a lorebook to a character as primary or auxiliary.
 */
async function openCharacterLinkPopup(apiName) {
    const record = findLorebook(apiName);
    if (!record) return;

    const context = getContext();
    const characters = context.characters || [];

    if (!characters.length) {
        toastr.warning('No characters found.');
        return;
    }

    // Build character options. Mark the character currently open in the editor,
    // since Primary linking only works for that one.
    const currentChar = context.characters?.[context.characterId] || null;
    const currentAvatar = currentChar?.avatar || '';

    const charOptions = characters
        .map((char, index) => ({
            name: char?.name || char?.avatar || `Character ${index}`,
            index,
            avatar: char?.avatar || '',
            isCurrent: !!char?.avatar && char.avatar === currentAvatar,
        }))
        .filter(c => c.avatar)
        .sort((a, b) => a.name.localeCompare(b.name));

    const charSelectHtml = charOptions
        .map(c => {
            const label = c.isCurrent ? `${c.name} (current)` : c.name;
            const selected = c.isCurrent ? ' selected' : '';
            return `<option value="${c.index}" data-current="${c.isCurrent ? '1' : '0'}"${selected}>${escapeHtml(label)}</option>`;
        })
        .join('');

    // Show current bindings
    const currentBindings = getCharacterBindingsForLorebook(apiName);
    let bindingsHtml = '';
    if (currentBindings.length) {
        const rows = currentBindings.map(b => {
            const typeLabel = b.type === 'primary' ? 'Primary' : 'Auxiliary';
            return `<div class="lmb_char_link_row" style="justify-content:space-between">
                <span><i class="fa-solid fa-user"></i> ${escapeHtml(b.charName)} — <strong>${typeLabel}</strong></span>
                <button type="button" class="menu_button menu_button_icon interactable lmb_char_unlink_btn"
                    data-char-index="${b.charIndex}" data-link-type="${b.type}" title="Remove binding">
                    <i class="fa-solid fa-link-slash"></i>
                </button>
            </div>`;
        }).join('');
        bindingsHtml = `<div class="lmb_char_link_info" style="margin-bottom:12px">
            <strong>Current bindings:</strong>
            ${rows}
        </div>`;
    }

    const html = `
    <div class="lmb_char_link_popup">
        ${bindingsHtml}
        <div class="lmb_char_link_row">
            <label for="lmb_char_select">Character:</label>
            <select id="lmb_char_select" class="text_pole textarea_compact">
                ${charSelectHtml}
            </select>
        </div>
        <div class="lmb_char_link_row">
            <label for="lmb_link_type">Type:</label>
            <select id="lmb_link_type" class="text_pole textarea_compact">
                <option value="primary">Primary Lorebook</option>
                <option value="extra">Auxiliary Lorebook</option>
            </select>
        </div>
        <div class="lmb_char_link_info">
            <i class="fa-solid fa-circle-info"></i>
            <strong>Primary</strong> — the main lorebook bound to the character card.<br>
            <strong>Auxiliary</strong> — additional lorebook loaded alongside the primary one.
        </div>
        <div class="lmb_char_link_warn" id="lmb_primary_warn" style="display:none">
            <i class="fa-solid fa-triangle-exclamation"></i>
            Primary linking only works for the character currently open in the editor.
            Open that character first, or use <strong>Auxiliary</strong> instead.
        </div>
    </div>`;

    // Handle unlink button clicks
    const onUnlinkClick = async (e) => {
        const btn = e.target.closest('.lmb_char_unlink_btn');
        if (!btn) return;

        const charIndex = parseInt(btn.dataset.charIndex, 10);
        const linkType = btn.dataset.linkType;
        const character = characters[charIndex];
        if (!character) return;

        try {
            if (linkType === 'primary') {
                if (!isCurrentCharacter(character)) {
                    toastr.warning(`Open "${escapeHtml(character.name)}" in the character panel first to remove its primary lorebook.`);
                    return;
                }
                await setCharacterPrimaryLorebook(character, '');
                toastr.success(`Removed primary lorebook from "${escapeHtml(character.name)}".`);
            } else {
                removeCharacterExtraLorebook(character, apiName);
                toastr.success(`Removed auxiliary lorebook from "${escapeHtml(character.name)}".`);
            }
            btn.closest('.lmb_char_link_row')?.remove();
            syncActiveLorebooks();
            renderManager();
        } catch (error) {
            if (error?.message === 'NOT_CURRENT_CHARACTER') {
                toastr.warning(`Open "${escapeHtml(character.name)}" in the character panel first to change its primary lorebook.`);
                return;
            }
            console.error('[Lorebook Manager] Failed to unlink', error);
            toastr.error('Failed to remove binding.');
        }
    };
    document.addEventListener('click', onUnlinkClick, true);

    // Track the current selection in closure variables. The popup DOM is torn
    // down before `await Popup.show.confirm()` resolves, so reading the
    // <select> elements afterwards would always return null. We capture the
    // values live instead.
    let selectedCharIndex = charOptions.length
        ? (charOptions.find(c => c.isCurrent)?.index ?? charOptions[0].index)
        : NaN;
    let selectedType = 'primary';

    // Live validation: Primary only works for the current character. When the
    // selected character isn't current and Primary is chosen, show a warning
    // and disable the Primary option.
    const onSelectionChange = () => {
        const charSel = document.getElementById('lmb_char_select');
        const typeSel = document.getElementById('lmb_link_type');
        const warn = document.getElementById('lmb_primary_warn');
        if (!charSel || !typeSel) return;

        const selectedOption = charSel.options[charSel.selectedIndex];
        const isCurrent = selectedOption?.dataset?.current === '1';

        const primaryOption = typeSel.querySelector('option[value="primary"]');
        if (primaryOption) primaryOption.disabled = !isCurrent;

        // If primary is selected but unavailable, fall back to auxiliary.
        if (!isCurrent && typeSel.value === 'primary') {
            typeSel.value = 'extra';
        }

        if (warn) {
            warn.style.display = isCurrent ? 'none' : 'block';
        }

        // Capture live so we can use them after the popup closes.
        selectedCharIndex = parseInt(charSel.value, 10);
        selectedType = typeSel.value;
    };
    const onPopupChange = (e) => {
        if (e.target?.id === 'lmb_char_select' || e.target?.id === 'lmb_link_type') {
            onSelectionChange();
        }
    };
    document.addEventListener('change', onPopupChange, true);
    // Run once on open to set the initial state.
    setTimeout(onSelectionChange, 0);

    // try/finally guarantees the document-level capture listeners are removed
    // even if Popup.show.confirm() rejects/throws — otherwise they would leak
    // permanently and keep firing on every page click.
    let result;
    try {
        result = await Popup.show.confirm(
            `Link: ${escapeHtml(record.displayName)}`,
            html,
        );
    } finally {
        document.removeEventListener('click', onUnlinkClick, true);
        document.removeEventListener('change', onPopupChange, true);
    }

    if (!result) return;

    const character = characters[selectedCharIndex];

    console.debug('[Lorebook Manager] Link confirm:', {
        apiName,
        selectedCharIndex,
        selectedType,
        characterName: character?.name,
        isCurrent: isCurrentCharacter(character),
    });

    if (!character) {
        toastr.error('Character not found.');
        return;
    }

    try {
        if (selectedType === 'primary') {
            // Primary linking only works for the current character.
            if (!isCurrentCharacter(character)) {
                toastr.warning(`Open "${escapeHtml(character.name)}" in the character panel first to set its primary lorebook, or use Auxiliary instead.`);
                return;
            }
            // Warn if character already has a different primary lorebook
            const currentPrimary = character.data?.extensions?.world;
            if (currentPrimary && currentPrimary.trim() && currentPrimary.trim() !== apiName) {
                const overwrite = await Popup.show.confirm(
                    'Replace primary lorebook?',
                    `"${escapeHtml(character.name)}" already has primary lorebook "<strong>${escapeHtml(currentPrimary)}</strong>". Replace it with "<strong>${escapeHtml(record.displayName)}</strong>"?`,
                );
                if (!overwrite) return;
            }
            await setCharacterPrimaryLorebook(character, apiName);
            toastr.success(`Set "${escapeHtml(record.displayName)}" as primary lorebook for "${escapeHtml(character.name)}".`);
        } else {
            // Check if already linked
            const extras = getCharacterExtraLorebooks(character);
            if (extras.includes(apiName)) {
                toastr.info(`"${escapeHtml(record.displayName)}" is already an auxiliary lorebook for "${escapeHtml(character.name)}".`);
                return;
            }
            addCharacterExtraLorebook(character, apiName);
            toastr.success(`Added "${escapeHtml(record.displayName)}" as auxiliary lorebook for "${escapeHtml(character.name)}".`);
        }

        syncActiveLorebooks();
        renderManager();
    } catch (error) {
        if (error?.message === 'NOT_CURRENT_CHARACTER') {
            toastr.warning(`Open "${escapeHtml(character.name)}" in the character panel first to change its primary lorebook.`);
            return;
        }
        console.error('[Lorebook Manager] Failed to link lorebook', error);
        toastr.error('Failed to link lorebook to character.');
    }
}


// ══════════════════════════════════════════════════════════════
// FEATURE: TAG SYSTEM
// ══════════════════════════════════════════════════════════════

function getTagList() {
    const settings = getManagerSettings();
    if (!Array.isArray(settings.tagList)) settings.tagList = [];
    return settings.tagList;
}

function getLorebookTags(apiName) {
    const settings = getManagerSettings();
    if (!isObject(settings.lorebookTags)) settings.lorebookTags = {};
    return settings.lorebookTags[apiName] || [];
}

function setLorebookTags(apiName, tags) {
    const settings = getManagerSettings();
    if (!isObject(settings.lorebookTags)) settings.lorebookTags = {};
    settings.lorebookTags[apiName] = [...new Set(tags.map(t => t.trim()).filter(Boolean))];
    saveManagerSettings();
}

function ensureTagExists(tagName) {
    const settings = getManagerSettings();
    if (!Array.isArray(settings.tagList)) settings.tagList = [];
    const normalized = tagName.trim();
    if (!normalized) return;
    if (!settings.tagList.includes(normalized)) {
        settings.tagList.push(normalized);
        settings.tagList.sort((a, b) => a.localeCompare(b));
        saveManagerSettings();
    }
}

async function openTagEditor(apiName) {
    const record = findLorebook(apiName);
    if (!record) return;

    const currentTags = getLorebookTags(apiName);
    const allTags = getTagList();

    // Track checked tags in a Set so we don't depend on DOM after popup closes
    const checkedSet = new Set(currentTags);

    const checkboxes = allTags.map(tag => {
        const checked = currentTags.includes(tag) ? 'checked' : '';
        return `<div class="lmb_tag_row">
            <label class="lmb_tag_label"><input type="checkbox" class="lmb_tag_cb" value="${escapeAttr(tag)}" ${checked}/> ${escapeHtml(tag)}</label>
            <button type="button" class="lmb_tag_delete_btn menu_button menu_button_icon interactable" data-tag-name="${escapeAttr(tag)}" title="Delete tag globally">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>`;
    }).join('');

    const html = `
    <div class="lmb_tag_editor">
        <div class="lmb_tag_existing">${checkboxes || '<p style="opacity:0.6">No tags created yet. Add one below!</p>'}</div>
        <hr/>
        <div class="lmb_tag_new_row">
            <input type="text" class="text_pole" id="lmb_new_tag_input" placeholder="New tag name..." />
            <button class="menu_button menu_button_icon interactable" id="lmb_add_tag_btn" type="button">
                <i class="fa-solid fa-plus"></i> Add
            </button>
        </div>
    </div>`;

    // Listen for checkbox changes in real time (before popup closes)
    const onCheckboxChange = (e) => {
        const cb = e.target.closest('.lmb_tag_cb');
        if (!cb) return;
        if (cb.checked) checkedSet.add(cb.value);
        else checkedSet.delete(cb.value);
    };
    document.addEventListener('change', onCheckboxChange, true);

    let result;
    try {
        result = await Popup.show.confirm(`Tags: ${escapeHtml(record.displayName)}`, html);
    } finally {
        document.removeEventListener('change', onCheckboxChange, true);
    }

    if (result) {
        setLorebookTags(apiName, [...checkedSet]);
        renderManager();
    }
}

function removeGlobalTag(tagName) {
    const settings = getManagerSettings();
    if (!Array.isArray(settings.tagList)) return;
    settings.tagList = settings.tagList.filter(t => t !== tagName);
    if (isObject(settings.lorebookTags)) {
        for (const key of Object.keys(settings.lorebookTags)) {
            settings.lorebookTags[key] = settings.lorebookTags[key].filter(t => t !== tagName);
            if (!settings.lorebookTags[key].length) delete settings.lorebookTags[key];
        }
    }
    if (state.activeTagFilter === tagName) {
        state.activeTagFilter = null;
    }
    saveManagerSettings();
}

// Global handler for "Add tag" and "Delete tag" buttons inside the popup.
// Scoped to clicks happening within an open .lmb_tag_editor to avoid
// leaking handlers into unrelated UI elsewhere in SillyTavern.
document.addEventListener('click', async (e) => {
    const editor = e.target.closest('.lmb_tag_editor');
    if (!editor) return;

    if (e.target.closest('#lmb_add_tag_btn')) {
        const input = editor.querySelector('#lmb_new_tag_input');
        if (!input) return;
        const name = input.value.trim();
        if (!name) {
            toastr.warning('Enter a tag name.');
            return;
        }
        ensureTagExists(name);
        const container = editor.querySelector('.lmb_tag_existing');
        if (container) {
            const placeholder = container.querySelector('p');
            if (placeholder) placeholder.remove();
            const row = document.createElement('div');
            row.className = 'lmb_tag_row';
            row.innerHTML = `<label class="lmb_tag_label"><input type="checkbox" class="lmb_tag_cb" value="${escapeAttr(name)}" checked/> ${escapeHtml(name)}</label>
                <button type="button" class="lmb_tag_delete_btn menu_button menu_button_icon interactable" data-tag-name="${escapeAttr(name)}" title="Delete tag globally">
                    <i class="fa-solid fa-trash-can"></i>
                </button>`;
            container.appendChild(row);
        }
        input.value = '';
        toastr.success(`Tag "${escapeHtml(name)}" added.`);
        return;
    }

    const deleteBtn = e.target.closest('.lmb_tag_delete_btn');
    if (deleteBtn) {
        const tagName = deleteBtn.dataset.tagName;
        if (!tagName) return;
        const confirmed = await Popup.show.confirm(
            'Delete tag?',
            `Remove "${escapeHtml(tagName)}" from ALL lorebooks?`,
        );
        if (!confirmed) return;
        removeGlobalTag(tagName);
        const row = deleteBtn.closest('.lmb_tag_row');
        if (row) row.remove();
        const container = editor.querySelector('.lmb_tag_existing');
        if (container && !container.querySelector('.lmb_tag_row')) {
            container.innerHTML = '<p style="opacity:0.6">No tags created yet. Add one below!</p>';
        }
        toastr.info(`Tag "${escapeHtml(tagName)}" deleted.`);
    }
});

// Handle Enter key in tag input (scoped to .lmb_tag_editor).
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target?.id !== 'lmb_new_tag_input') return;
    const editor = e.target.closest('.lmb_tag_editor');
    if (!editor) return;
    e.preventDefault();
    editor.querySelector('#lmb_add_tag_btn')?.click();
});


function initialize() {
    if (state.initialized) {
        return;
    }

    state.initialized = true;

    const settings = getManagerSettings();

    // v2: Reset firstSeen data to fix sort order from previous buggy version
    if (settings._firstSeenVersion !== 2) {
        settings.firstSeen = {};
        settings._firstSeenVersion = 2;
        saveManagerSettings();
    }

    state.activeFolderId = settings.activeFolderId;
    state.sort = settings.sort;
    state.pageSize = settings.pageSize;

    startButtonObserver();
    hijackWorldInfoDrawer();

    const context = getContext();
    context.eventSource.on(context.eventTypes.WORLDINFO_UPDATED, handleWorldInfoUpdated);
    context.eventSource.on(context.eventTypes.WORLDINFO_SETTINGS_UPDATED, () => {
        renderManager();
    });
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        renderManager();
    });
}

if (document.readyState === 'complete') {
    initialize();
} else {
    window.addEventListener('load', initialize, { once: true });
}
