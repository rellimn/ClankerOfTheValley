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

/* global Packages */

(function () {
    /*
     * @transformer nexttime
     * @category time
     * @formula (nexttime time:str) converts a 24-hour HH:MM time to the next occurrence as a date/time string with a UTC offset
     * @labels twitch discord noevent time
     * @notes Uses the bot's configured timezone (set with !timezone, default GMT). The result can be passed to (countdown).
     * @notes Selects today if the time is still ahead, otherwise the next day on which that local time exists. Seconds are set to zero. The result is recalculated each time the command runs.
     * @notes During daylight-saving changes, nonexistent local times are skipped and repeated local times use the first occurrence still in the future.
     * @example Caster: !addcom !alarm Time until 01:30: (countdown (nexttime 01:30))
     * @cached
     */
    function nexttime(args) {
        let match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(args.args || '');
        if (!match) {
            return {result: $.lang.get('customcommands.datetime.format.invalid', args.args)};
        }

        let zone = Packages.java.time.ZoneId.of($.getIniDbString('settings', 'timezone', 'GMT')),
                now = Packages.java.time.Instant.ofEpochMilli(Date.now()),
                date = now.atZone(zone).toLocalDate(),
                time = Packages.java.time.LocalTime.of(parseInt(match[1], 10), parseInt(match[2], 10)),
                rules = zone.getRules();

        while (true) {
            let local = date.atTime(time),
                    offsets = rules.getValidOffsets(local);
            // A gap has no offsets; an overlap has two, with the earlier occurrence first.
            for (let i = 0; i < offsets.size(); i++) {
                let candidate = local.atOffset(offsets.get(i));
                if (candidate.toInstant().isAfter(now)) {
                    return {
                        result: candidate.format(Packages.java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX")),
                        cache: true
                    };
                }
            }
            date = date.plusDays(1);
        }
    }

    $.transformers.addTransformer(new $.transformers.transformer('nexttime', ['twitch', 'discord', 'noevent', 'time'], nexttime));
})();
