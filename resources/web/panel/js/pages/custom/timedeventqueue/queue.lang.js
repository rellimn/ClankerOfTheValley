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

/*
 * Editable UI strings for the Timed Event Queue panel page. The browser panel has no
 * built-in i18n, so this object is the single place to change every visible string on the
 * page. queue.html elements reference these keys via data-teq-lang / data-teq-lang-title /
 * data-teq-lang-html attributes, and queue.js reads them for everything it renders.
 *
 * Loaded before queue.js (see the <script> order in queue.html).
 */
window.TEQ_LANG = {
    // Header / breadcrumb
    title: 'Redeem Queue',
    navHome: 'Home',
    navExtra: 'Extra',

    // Read-only banner (HTML allowed)
    readonlyBanner: '<i class="fa fa-lock"></i> <b>Read-only access.</b> You can view the queue but not control it. '
        + 'Grant <b>Settings &rarr; Panel Users &rarr; Extra &rarr; Full Access</b> (or log in as the config user) '
        + 'to accept, reject, reorder, adjust timers, and change settings.',

    // Queue box
    boxQueue: 'Queue',
    badgeAccepting: 'Accepting',
    badgeClosed: 'Closed',
    toggleTip: 'Accept new redeems',
    itemsOne: 'item',
    itemsMany: 'items',
    colNum: '#',
    colSender: 'Sender',
    colContent: 'Content',
    colSent: 'Sent',
    colTimeLeft: 'Time left',
    colActions: 'Actions',
    queueEmpty: 'The queue is empty.',

    // Settings box
    boxSettings: 'Settings',
    tipExpand: 'Expand',
    tipCollapse: 'Collapse',
    labelHighlight: 'Expiry highlight style',
    optHlPulse: 'Pulse (flashing red)',
    optHlSolid: 'Solid red',
    optHlBorder: 'Red border',
    optHlNone: 'None',
    labelSound: 'Play sound on expiry',
    optYes: 'Yes',
    optNo: 'No',
    labelTone: 'Sound tone',
    optToneBeep: 'Beep',
    optToneLow: 'Low',
    optToneHigh: 'High',
    optToneDouble: 'Double beep',
    labelVolume: 'Sound volume (0–100)',
    labelWarn: 'Warning threshold (seconds)',
    helpWarn: 'Countdown turns red at/below this. 0 disables.',
    labelLinkedRedeemables: 'Linked Channel Point redeems',
    helpLinkedRedeemables: 'Use Ctrl/Cmd-click to select the redeems that submit to this queue. Closing submissions pauses them; reopening resumes them. Only rewards created by PhantomBot can be updated.',
    btnRefreshRedeemables: 'Refresh redeems',
    noRedeemables: 'No Channel Point redeems found.',
    btnTest: 'Test sound',
    btnSave: 'Save settings',

    // History box
    boxHistory: 'History',
    colOutcome: 'Outcome',
    colWhen: 'When',
    historyEmpty: 'No history yet.',

    // Row action buttons / states (rendered by queue.js)
    btnAccept: 'Accept',
    btnReject: 'Reject',
    btnComplete: 'Complete',
    btnPause: 'Pause',
    btnResume: 'Resume',
    btnAdjust: '30s',
    tipDrag: 'Drag to reorder',
    readonlyTitle: 'Read-only panel user (no changes allowed).',
    timeUp: 'TIME UP',
    pausedSuffix: ' (paused)',
    histCompleted: 'Completed',
    histRejected: 'Rejected',

    // Toast
    toastSaved: 'Saved queue settings.'
};
