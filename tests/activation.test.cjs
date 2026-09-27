const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../index.js'), 'utf8');
const toggleSource = source.slice(
    source.indexOf('async function toggleLorebookActive('),
    source.indexOf('async function onLorebookGridClick('),
);

function setup({ names = ['Other', 'Book'], selected = [], options, missingSelect = false, fail = false } = {}) {
    class Option {
        constructor(text, value, defaultSelected = false, selected = false) {
            this.textContent = text;
            this.value = value;
            this.selected = selected;
        }
    }
    class Select {
        options = options ?? names.map((name, i) => new Option(name, String(i), false, selected.includes(name)));
        add(option) { this.options.push(option); }
        dispatchEvent() { throw new Error('Unscoped change must not overwrite the API selection'); }
    }
    const select = new Select();
    const notices = [];
    const events = [];
    let pendingSave;
    let renders = 0;
    const context = vm.createContext({
        selected_world_info: [...selected],
        world_names: names,
        // ST persists globalSelect separately from its live selected array.
        world_info: { globalSelect: [...selected], charLore: [{ name: 'Character', extraBooks: ['Book'] }] },
        HTMLSelectElement: Select,
        Option,
        document: { getElementById: () => missingSelect ? null : select },
        $: () => ({ trigger: event => events.push(event) }),
        console: { error() {} },
        toastr: Object.fromEntries(['info', 'success', 'error'].map(type => [type, message => notices.push({ type, message })])),
        renderManager: () => { renders++; },
        getContext: () => ({
            saveSettingsDebounced: () => { throw new Error('Use the World Info settings API'); },
            eventTypes: { WORLDINFO_SETTINGS_UPDATED: 'wi-updated' },
            eventSource: { emit: async event => { events.push(event); } },
        }),
        updateWorldInfoSettings: (_settings, next) => {
            if (fail) throw new Error('API failure');
            context.selected_world_info = next;
            pendingSave = () => { context.world_info.globalSelect = [...context.selected_world_info]; };
        },
    });
    vm.runInContext(toggleSource, context);
    return {
        context, select, notices, events,
        toggle: name => context.toggleLorebookActive(name),
        flushSave: () => pendingSave?.(),
        get renders() { return renders; },
    };
}

test('activation and deactivation persist, preserve other books and notify after the update', async () => {
    const app = setup({ selected: ['Other'] });
    await app.toggle('Book');
    app.flushSave();
    assert.deepEqual([...app.context.selected_world_info], ['Other', 'Book']);
    assert.deepEqual([...app.context.world_info.globalSelect], ['Other', 'Book']);
    assert.equal(app.select.options[1].selected, true);
    assert.deepEqual(app.events, ['change.select2', 'wi-updated']);
    assert.equal(app.notices.at(-1).type, 'success');

    await app.toggle('Book');
    app.flushSave();
    assert.deepEqual([...app.context.selected_world_info], ['Other']);
    assert.deepEqual([...app.context.world_info.globalSelect], ['Other']);
    assert.equal(app.select.options[1].selected, false);
    assert.equal(app.notices.at(-1).type, 'info');
    assert.equal(app.renders, 2);
    assert.deepEqual(app.context.world_info.charLore[0].extraBooks, ['Book']);
});

test('option identity uses indices even when labels differ from exact filenames', async () => {
    const name = '  Lore &amp; <world>, "quoted"  ';
    const app = setup({ names: [name], options: [{ value: '0', textContent: 'Lore & , "quoted"', selected: false }] });
    await app.toggle(name);
    app.flushSave();
    assert.equal(app.select.options[0].selected, true);
    assert.deepEqual([...app.context.world_info.globalSelect], [name]);
    await app.toggle(name);
    assert.equal(app.select.options[0].selected, false);
});

test('missing options are created safely and placeholder is not selected', async () => {
    const name = '<b>Book</b>';
    const app = setup({ names: [name], options: [{ value: '', textContent: 'None', selected: true }] });
    await app.toggle(name);
    assert.equal(app.select.options[0].selected, false);
    assert.equal(app.select.options.length, 2);
    assert.equal(app.select.options[1].textContent, name);
    assert.equal(app.select.options[1].value, '0');
    assert.equal(app.select.options[1].selected, true);
});

test('selection persists even when the native selector is unavailable', async () => {
    const app = setup({ missingSelect: true });
    await app.toggle('Book');
    app.flushSave();
    assert.deepEqual([...app.context.world_info.globalSelect], ['Book']);
    assert.deepEqual(app.events, ['wi-updated']);
});

test('deactivation removes duplicate selections', async () => {
    const app = setup({ selected: ['Book', 'Other', 'Book'] });
    await app.toggle('Book');
    app.flushSave();
    assert.deepEqual([...app.context.world_info.globalSelect], ['Other']);
});

test('missing books and API failures report an error without a success notification', async () => {
    for (const app of [setup({ names: ['Other'] }), setup({ fail: true })]) {
        await app.toggle('Book');
        app.flushSave();
        assert.deepEqual([...app.context.selected_world_info], []);
        assert.deepEqual([...app.context.world_info.globalSelect], []);
        assert.equal(app.notices.length, 1);
        assert.equal(app.notices[0].type, 'error');
        assert.deepEqual(app.events, []);
    }
});
