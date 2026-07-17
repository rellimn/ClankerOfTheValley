/*
 * Copyright (C) 2016-2026 phantombot.github.io/PhantomBot
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/* global socket, helpers, toastr */

$(function () {
    var SECTION = 'extra',
        SCRIPT = './custom/giftSubCurrencyRewards/giftSubCurrencyRewards.js',
        SETTINGS = 'giftSubCurrencyRewards',
        FORMULAS = 'giftSubCurrencyRewardFormulas',
        SOURCE_LABELS = {
            giftsub: 'Tier 1 Gift Subs', giftsub2: 'Tier 2 Gift Subs', giftsub3: 'Tier 3 Gift Subs',
            sub1: 'Tier 1 Subs', sub2: 'Tier 2 Subs', sub3: 'Tier 3 Subs',
            resub1: 'Tier 1 Resubs', resub2: 'Tier 2 Resubs', resub3: 'Tier 3 Resubs',
            bits: 'Bits', streamelements: 'StreamElements'
        },
        currencyDefs = {},
        formulas = {};

    function isWritable() {
        var ns = window.__pbCustomPanel__;
        return (ns && typeof ns.panelSectionCanWrite === 'function') ? ns.panelSectionCanWrite(SECTION) : true;
    }

    function canWrite() {
        var ns = window.__pbCustomPanel__;
        return (ns && typeof ns.requirePanelSectionWrite === 'function') ? ns.requirePanelSectionWrite(SECTION) : true;
    }

    function sanitizeId(raw) {
        return String(raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    }

    function parseDef(value) {
        try {
            var o = JSON.parse(value);
            return {name: o.name || '', plural: o.plural || o.name || ''};
        } catch (e) {
            return {name: String(value || ''), plural: String(value || '')};
        }
    }

    function evaluateFormula(formula, x) {
        var input = String(formula || ''), index = 0, length = input.length;
        function skip() { while (index < length && /\s/.test(input.charAt(index))) { index++; } }
        function startsFactor() {
            skip();
            return index < length && (input.charAt(index) === '(' || input.charAt(index).toLowerCase() === 'x' || input.charAt(index) === '.' || /[0-9]/.test(input.charAt(index)));
        }
        function factor() {
            var sign = 1, match, value;
            skip();
            while (input.charAt(index) === '+' || input.charAt(index) === '-') {
                if (input.charAt(index++) === '-') { sign *= -1; }
                skip();
            }
            if (input.charAt(index) === '(') {
                index++; value = expression(); skip();
                if (input.charAt(index) !== ')') { throw 'parenthesis'; }
                index++; return sign * value;
            }
            if (input.charAt(index).toLowerCase() === 'x') { index++; return sign * x; }
            match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(input.substring(index));
            if (!match) { throw 'factor'; }
            index += match[0].length;
            return sign * parseFloat(match[0]);
        }
        function term() {
            var value = factor(), op, right;
            while (true) {
                skip(); op = input.charAt(index);
                if (op === '*' || op === '/') {
                    index++; right = factor();
                    if (op === '/' && right === 0) { throw 'zero'; }
                    value = op === '*' ? value * right : value / right;
                } else if (startsFactor()) { value *= factor(); } else { return value; }
            }
        }
        function expression() {
            var value = term(), op;
            while (true) {
                skip(); op = input.charAt(index);
                if (op !== '+' && op !== '-') { return value; }
                index++; value = op === '+' ? value + term() : value - term();
            }
        }
        try {
            if (input.trim() === '') { return null; }
            var result = expression(); skip();
            return index === length && isFinite(result) ? result : null;
        } catch (e) { return null; }
    }

    function applyWritable() {
        var writable = isWritable();
        $('#gscr-readonly-banner').toggle(!writable);
        $('#gscr-enabled, #gscr-message, #gscr-formula-source, #gscr-save-settings, #gscr-save-formula, #gscr-clear-formula').prop('disabled', !writable);
    }

    function loadCurrencies(selected) {
        socket.getDBTableValues('gscr_currency_defs', 'currencyDefs', function (results) {
            var $currency = $('#gscr-currency').empty(), i, id;
            currencyDefs = {};
            for (i = 0; i < results.length; i++) {
                id = sanitizeId(results[i].key);
                currencyDefs[id] = parseDef(results[i].value);
                $currency.append($('<option/>', {value: id, text: id + ' (' + currencyDefs[id].name + ')', selected: String(selected) === id}));
            }
            $('#gscr-no-currencies').toggle(results.length === 0);
            renderFormulaTable();
            renderPreview();
        });
    }

    function loadFormulas(callback) {
        socket.getDBTableValues('gscr_formulas', FORMULAS, function (results) {
            var i;
            formulas = {};
            for (i = 0; i < results.length; i++) {
                if (/^(giftsub[23]?|sub[123]|resub[123]|bits|streamelements):[a-z0-9_]+$/.test(String(results[i].key).toLowerCase())) {
                    formulas[String(results[i].key).toLowerCase()] = String(results[i].value || '');
                }
            }
            renderFormulaTable();
            renderPreview();
            if (typeof callback === 'function') { callback(); }
        });
    }

    function loadSettings() {
        socket.getDBValues('gscr_settings', {
            tables: [SETTINGS, SETTINGS],
            keys: ['enabled', 'message']
        }, true, function (e) {
            $('#gscr-enabled').prop('checked', e.enabled === null || e.enabled === undefined ? true : helpers.isTrue(e.enabled));
            $('#gscr-message').val(e.message === null || e.message === undefined ? '' : String(e.message));
            renderPreview();
        });
    }

    function saveSettings() {
        if (!canWrite()) { return; }
        socket.updateDBValues('gscr_save_settings', {
            tables: [SETTINGS, SETTINGS],
            keys: ['enabled', 'message'],
            values: [$('#gscr-enabled').is(':checked'), $('#gscr-message').val()]
        }, function () {
            socket.wsEvent('gscr_reload', SCRIPT, null, ['reload'], function () { toastr.success('Payment reward settings saved.'); });
        });
    }

    function renderFormulaTable() {
        var rows = [], keys = Object.keys(formulas).sort(), i, key, pieces, source, currencyId;
        for (i = 0; i < keys.length; i++) {
            key = keys[i];
            pieces = key.split(':');
            source = pieces[0];
            currencyId = pieces[1];
            rows.push([source, currencyId, formulas[key], $('<div/>', {'class': 'btn-group'})
                .append($('<button/>', {'type': 'button', 'class': 'btn btn-xs btn-warning gscr-edit-formula', 'data-source': source, 'data-currency': currencyId, 'html': $('<i/>', {'class': 'fa fa-edit'})}))
                .append($('<button/>', {'type': 'button', 'class': 'btn btn-xs btn-danger gscr-delete-formula', 'data-source': source, 'data-currency': currencyId, 'html': $('<i/>', {'class': 'fa fa-trash'})})).html()]);
        }
        if ($.fn.DataTable.isDataTable('#giftSubCurrencyRewardsTable')) {
            $('#giftSubCurrencyRewardsTable').DataTable().clear().rows.add(rows).invalidate().draw(false);
            return;
        }
        var table = $('#giftSubCurrencyRewardsTable').DataTable({
            searching: false,
            autoWidth: false,
            data: rows,
            order: [[0, 'asc'], [1, 'asc']],
            columnDefs: [{orderable: false, targets: [3]}],
            columns: [{title: 'Source'}, {title: 'Currency'}, {title: 'Direct formula'}, {title: 'Actions'}]
        });
        table.on('click', '.gscr-edit-formula', function () {
            var source = $(this).data('source'),
                currencyId = $(this).data('currency');
            $('#gscr-formula-source').val(source);
            $('#gscr-currency').val(currencyId);
            $('#gscr-formula').val(formulas[source + ':' + currencyId]);
            renderPreview();
        });
        table.on('click', '.gscr-delete-formula', function () {
            clearFormula($(this).data('source'), $(this).data('currency'));
        });
    }

    function saveFormula() {
        var source = String($('#gscr-formula-source').val() || ''),
            currencyId = String($('#gscr-currency').val() || ''),
            formula = String($('#gscr-formula').val() || ''),
            key = source + ':' + currencyId,
            test;
        if (!canWrite()) { return; }
        if (source === '' || currencyId === '') {
            toastr.error('Select a source and currency.');
            return;
        }
        test = evaluateFormula(formula, 1);
        if (test === null) {
            toastr.error('Formula is invalid. Use x, numbers, +, -, *, / and parentheses.');
            return;
        }
        socket.updateDBValue('gscr_save_formula', FORMULAS, key, formula, function () {
            toastr.success('Formula saved.');
            loadFormulas();
        });
    }

    function clearFormula(source, currencyId) {
        var key = source + ':' + currencyId;
        if (!canWrite()) { return; }
        helpers.getConfirmDeleteModal('gscr_delete_formula', 'Remove the ' + source + ' formula for ' + currencyId + '?', true, 'Formula removed.', function () {
            socket.removeDBValue('gscr_remove_formula', FORMULAS, key, function () { loadFormulas(); });
        });
    }

    function floorReward(value) {
        var tolerance = Math.max(1, Math.abs(value)) * 1e-12;
        return Math.floor(value + tolerance);
    }

    function currencyName(currencyId, amount) {
        var def = currencyDefs[currencyId];
        if (!def) { return currencyId; }
        return amount === 1 ? def.name : def.plural;
    }

    function renderPreview() {
        var source = String($('#gscr-preview-source').val() || 'giftsub'),
            units = parseFloat($('#gscr-preview-units').val()),
            currencyId = String($('#gscr-currency').val() || ''),
            key = source + ':' + currencyId,
            formula,
            granted,
            msg,
            user;
        if (isNaN(units) || units <= 0) { units = 1; }
        formula = formulas[key] || (source === String($('#gscr-formula-source').val()) ? String($('#gscr-formula').val() || '') : '');
        granted = evaluateFormula(formula, units);
        granted = granted === null ? 0 : Math.max(0, floorReward(granted));
        user = String($('#gscr-preview-user').val() || 'User');
        msg = String($('#gscr-message').val() || $('#gscr-message').attr('placeholder') || '')
            .replace(/\(name\)/g, user)
            .replace(/\(source\)/g, SOURCE_LABELS[source] || source)
            .replace(/\(unitamount\)/g, String(units))
            .replace(/\(amount\)/g, String(units))
            .replace(/\(giftedamount\)/g, String(units))
            .replace(/\(currencygranted\)/g, String(granted))
            .replace(/\(currencyname\)/g, currencyId === '' ? '' : currencyName(currencyId, granted))
            .replace(/\(currencybal\)/g, currencyId === '' ? '' : String(granted) + ' ' + currencyName(currencyId, granted));
        $('#gscr-preview-math').text('floor(' + (formula || 'no formula') + ') with x = ' + units + ' ' + source + ' = ' + granted);
        $('#gscr-message-preview').text(msg);
    }

    function insertTag(tag) {
        var el = $('#gscr-message').get(0), value = $('#gscr-message').val(), start = el.selectionStart || value.length, end = el.selectionEnd || value.length;
        $('#gscr-message').val(value.substring(0, start) + tag + value.substring(end));
        el.focus(); el.selectionStart = el.selectionEnd = start + tag.length; renderPreview();
    }

    applyWritable(); loadSettings(); loadCurrencies(); loadFormulas();
    $('#gscr-save-settings').on('click', saveSettings);
    $('#gscr-save-formula').on('click', saveFormula);
    $('#gscr-clear-formula').on('click', function () { clearFormula(String($('#gscr-formula-source').val() || ''), String($('#gscr-currency').val() || '')); });
    $('#gscr-currency, #gscr-formula-source').on('change', function () {
        var source = String($('#gscr-formula-source').val());
        $('#gscr-formula').val(formulas[source + ':' + String($('#gscr-currency').val())] || '');
        $('#gscr-preview-source').val(source);
        renderPreview();
    });
    $('#gscr-message, #gscr-formula, #gscr-preview-user, #gscr-preview-units').on('input', renderPreview);
    $('#gscr-preview-source').on('change', renderPreview);
    $('.gscr-tag').on('click', function () { insertTag($(this).data('tag')); });
});
