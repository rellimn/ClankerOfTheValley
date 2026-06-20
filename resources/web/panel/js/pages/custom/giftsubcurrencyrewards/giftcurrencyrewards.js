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
        REWARDS = 'giftSubCurrencyRewardBreakpoints',
        currencyDefs = {},
        rewardMaps = {};

    function isWritable() {
        var ns = window.__pbCustomPanel__;
        return (ns && typeof ns.panelSectionCanWrite === 'function') ? ns.panelSectionCanWrite(SECTION) : true;
    }

    function canWrite() {
        var ns = window.__pbCustomPanel__;
        return (ns && typeof ns.requirePanelSectionWrite === 'function') ? ns.requirePanelSectionWrite(SECTION) : true;
    }

    function applyWritable() {
        var w = isWritable();
        $('#gscr-readonly-banner').toggle(!w);
        $('#gscr-enabled, #gscr-message, #gscr-save-settings, #gscr-save-breakpoint, #gscr-clear-currency')
            .prop('disabled', !w);
    }

    function sanitizeId(raw) {
        return String(raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    }

    function parseDef(value) {
        try {
            var o = JSON.parse(value);
            return { name: o.name || '', plural: o.plural || o.name || '' };
        } catch (e) {
            return { name: String(value || ''), plural: String(value || '') };
        }
    }

    function parseMap(value) {
        try {
            var o = JSON.parse(value);
            return o === null ? {} : o;
        } catch (e) {
            return {};
        }
    }

    function sortedBreakpoints(map) {
        var out = [];
        for (var k in map) {
            if (map.hasOwnProperty(k) && parseInt(k, 10) > 0 && parseInt(map[k], 10) > 0) {
                out.push(parseInt(k, 10));
            }
        }
        out.sort(function (a, b) {
            return a - b;
        });
        return out;
    }

    function rewardFor(currencyId, giftedSubs) {
        var map = rewardMaps[currencyId] || {},
            points = sortedBreakpoints(map),
            reward = 0;

        for (var i = 0; i < points.length; i++) {
            if (points[i] <= giftedSubs) {
                reward = parseInt(map[String(points[i])], 10);
            } else {
                break;
            }
        }
        return reward;
    }

    function currencyName(currencyId, amount) {
        var def = currencyDefs[currencyId];
        if (!def) {
            return currencyId;
        }
        return parseInt(amount, 10) === 1 ? def.name : def.plural;
    }

    function currencyString(currencyId, amount) {
        return String(amount) + ' ' + currencyName(currencyId, amount);
    }

    function saveMap(currencyId, map, callback) {
        var hasAny = false;
        for (var k in map) {
            if (map.hasOwnProperty(k)) {
                hasAny = true;
                break;
            }
        }

        if (hasAny) {
            socket.updateDBValue('gscr_save_map', REWARDS, currencyId, JSON.stringify(map), callback);
        } else {
            socket.removeDBValue('gscr_remove_map', REWARDS, currencyId, callback);
        }
    }

    function loadCurrencies(selected) {
        socket.getDBTableValues('gscr_currency_defs', 'currencyDefs', function (results) {
            var $currency = $('#gscr-currency').empty();
            currencyDefs = {};

            for (var i = 0; i < results.length; i++) {
                var id = sanitizeId(results[i].key);
                currencyDefs[id] = parseDef(results[i].value);
                $currency.append($('<option/>', {
                    'value': id,
                    'text': id + ' (' + currencyDefs[id].name + ')',
                    'selected': String(selected) === id
                }));
            }

            $('#gscr-no-currencies').toggle(results.length === 0);
            renderTable();
            renderLadder();
            renderPreview();
        });
    }

    function loadRewards(callback) {
        socket.getDBTableValues('gscr_reward_maps', REWARDS, function (results) {
            rewardMaps = {};
            for (var i = 0; i < results.length; i++) {
                rewardMaps[sanitizeId(results[i].key)] = parseMap(results[i].value);
            }
            renderTable();
            renderLadder();
            renderPreview();
            if (typeof callback === 'function') {
                callback();
            }
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
        if (!canWrite()) {
            return;
        }

        socket.updateDBValues('gscr_save_settings', {
            tables: [SETTINGS, SETTINGS],
            keys: ['enabled', 'message'],
            values: [$('#gscr-enabled').is(':checked'), $('#gscr-message').val()]
        }, function () {
            socket.wsEvent('gscr_reload', SCRIPT, null, ['reload'], function () {
                toastr.success('Gift-sub reward message saved.');
            });
        });
    }

    function renderTable() {
        var rows = [],
            selected = String($('#gscr-currency').val() || ''),
            currencies = Object.keys(rewardMaps).sort();

        for (var i = 0; i < currencies.length; i++) {
            var currencyId = currencies[i],
                map = rewardMaps[currencyId] || {},
                points = sortedBreakpoints(map);

            if (selected !== '' && currencyId !== selected) {
                continue;
            }

            for (var j = 0; j < points.length; j++) {
                var subs = points[j],
                    reward = parseInt(map[String(subs)], 10),
                    next = points[j + 1],
                    range = next === undefined ? subs + '+' : subs + '-' + (next - 1);

                rows.push([
                    currencyId,
                    subs,
                    reward,
                    range,
                    $('<div/>', { 'class': 'btn-group' })
                        .append($('<button/>', {
                            'type': 'button',
                            'class': 'btn btn-xs btn-warning gscr-edit-breakpoint',
                            'data-currency': currencyId,
                            'data-subs': subs,
                            'data-reward': reward,
                            'html': $('<i/>', { 'class': 'fa fa-edit' })
                        }))
                        .append($('<button/>', {
                            'type': 'button',
                            'class': 'btn btn-xs btn-danger gscr-delete-breakpoint',
                            'data-currency': currencyId,
                            'data-subs': subs,
                            'html': $('<i/>', { 'class': 'fa fa-trash' })
                        })).html()
                ]);
            }
        }

        if ($.fn.DataTable.isDataTable('#giftSubCurrencyRewardsTable')) {
            $('#giftSubCurrencyRewardsTable').DataTable().clear().rows.add(rows).invalidate().draw(false);
            return;
        }

        var table = $('#giftSubCurrencyRewardsTable').DataTable({
            'searching': false,
            'autoWidth': false,
            'data': rows,
            'order': [[0, 'asc'], [1, 'asc']],
            'columnDefs': [
                { 'orderable': false, 'targets': [4] }
            ],
            'columns': [
                { 'title': 'Currency' },
                { 'title': 'Subs' },
                { 'title': 'Reward' },
                { 'title': 'Applies to' },
                { 'title': 'Actions' }
            ]
        });

        table.on('click', '.gscr-edit-breakpoint', function () {
            $('#gscr-currency').val($(this).data('currency'));
            $('#gscr-subs').val($(this).data('subs'));
            $('#gscr-reward').val($(this).data('reward'));
            renderLadder();
            renderPreview();
        });

        table.on('click', '.gscr-delete-breakpoint', function () {
            removeBreakpoint($(this).data('currency'), parseInt($(this).data('subs'), 10));
        });
    }

    function renderLadder() {
        var currencyId = String($('#gscr-currency').val() || ''),
            map = rewardMaps[currencyId] || {},
            points = sortedBreakpoints(map),
            $ladder = $('#gscr-ladder').empty(),
            parts = [];

        $('#gscr-ladder-empty').toggle(points.length === 0);
        $ladder.toggle(points.length > 0);

        if (points.length === 0) {
            $('#gscr-ladder-summary').text('');
            return;
        }

        for (var i = 0; i < points.length; i++) {
            var label = points[i] + '+ -> ' + map[String(points[i])],
                width = 100 / points.length;
            $ladder.append($('<div/>', {
                'class': 'progress-bar progress-bar-success',
                'style': 'width: ' + width + '%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
                'text': label
            }));
            parts.push(points[i] + ' gifted sub(s) grants ' + currencyString(currencyId, map[String(points[i])]));
        }

        $('#gscr-ladder-summary').text(parts.join(' | '));
    }

    function renderPreview() {
        var msg = String($('#gscr-message').val() || $('#gscr-message').attr('placeholder') || ''),
            user = String($('#gscr-preview-user').val() || 'User'),
            gifted = parseInt($('#gscr-preview-subs').val(), 10),
            currencyId = String($('#gscr-currency').val() || ''),
            granted;

        if (isNaN(gifted) || gifted <= 0) {
            gifted = 1;
        }

        granted = currencyId === '' ? 0 : rewardFor(currencyId, gifted);
        msg = msg.replace(/\(name\)/g, user)
            .replace(/\(giftedamount\)/g, String(gifted))
            .replace(/\(amount\)/g, String(gifted))
            .replace(/\(currencygranted\)/g, String(granted))
            .replace(/\(currencyname\)/g, currencyId === '' ? '' : currencyName(currencyId, granted))
            .replace(/\(currencybal\)/g, currencyId === '' ? '' : currencyString(currencyId, granted));

        $('#gscr-message-preview').text(msg);
    }

    function saveBreakpoint() {
        if (!canWrite()) {
            return;
        }
        var currencyId = String($('#gscr-currency').val() || ''),
            subs = parseInt($('#gscr-subs').val(), 10),
            reward = parseInt($('#gscr-reward').val(), 10),
            map;

        if (currencyId === '') {
            toastr.error('Select a currency.');
            return;
        }
        if (!helpers.handleInputNumber($('#gscr-subs'), 1) || !helpers.handleInputNumber($('#gscr-reward'), 1)) {
            return;
        }

        map = rewardMaps[currencyId] || {};
        map[String(subs)] = reward;
        saveMap(currencyId, map, function () {
            toastr.success('Breakpoint saved.');
            loadRewards();
        });
    }

    function removeBreakpoint(currencyId, subs) {
        if (!canWrite()) {
            return;
        }

        helpers.getConfirmDeleteModal('gscr_delete_breakpoint', 'Remove the ' + subs + ' sub breakpoint for ' + currencyId + '?', true,
            'Breakpoint removed.',
            function () {
                var map = rewardMaps[currencyId] || {};
                delete map[String(subs)];
                saveMap(currencyId, map, function () {
                    loadRewards();
                });
            });
    }

    function clearCurrency() {
        if (!canWrite()) {
            return;
        }
        var currencyId = String($('#gscr-currency').val() || '');
        if (currencyId === '') {
            return;
        }

        helpers.getConfirmDeleteModal('gscr_clear_currency', 'Remove every gift-sub breakpoint for ' + currencyId + '?', true,
            'Breakpoints cleared.',
            function () {
                socket.removeDBValue('gscr_clear_currency_do', REWARDS, currencyId, function () {
                    loadRewards();
                });
            });
    }

    function insertTag(tag) {
        var el = $('#gscr-message').get(0),
            value = $('#gscr-message').val(),
            start = el.selectionStart || value.length,
            end = el.selectionEnd || value.length;

        $('#gscr-message').val(value.substring(0, start) + tag + value.substring(end));
        el.focus();
        el.selectionStart = el.selectionEnd = start + tag.length;
        renderPreview();
    }

    applyWritable();
    loadSettings();
    loadCurrencies();
    loadRewards();

    $('#gscr-save-settings').on('click', saveSettings);
    $('#gscr-save-breakpoint').on('click', saveBreakpoint);
    $('#gscr-clear-currency').on('click', clearCurrency);
    $('#gscr-currency').on('change', function () {
        renderTable();
        renderLadder();
        renderPreview();
    });
    $('#gscr-message, #gscr-preview-user, #gscr-preview-subs').on('input', renderPreview);
    $('.gscr-tag').on('click', function () {
        insertTag($(this).data('tag'));
    });
});
