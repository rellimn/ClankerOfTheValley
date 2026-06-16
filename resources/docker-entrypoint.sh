#!/bin/bash
set -e

if [[ ${UID+x} && ${GID+x} ]]; then
	if [[ "$(id -u phantombot)" != $UID ]] || [[ "$(id -g phantombot)" != $GID ]]; then
		echo "Setting user to UID/GID: $UID / $GID"
		groupmod -o -g $GID phantombot
		usermod -o -u $UID -g $GID phantombot
	fi
fi

mkdir -p /opt/PhantomBot_data/logs /opt/PhantomBot_data/dbbackup /opt/PhantomBot_data/addons /opt/PhantomBot_data/config /opt/PhantomBot_data/gameslist
touch /opt/PhantomBot_data/gameslist/gamesList.txt

# allow the container to be started with `--user`
if [ "$(id -u)" = '0' -a ! -v ALLOW_ROOT ]; then
	chown -R phantombot:phantombot /opt/PhantomBot_data;
	find /opt/PhantomBot \! -type l \! -user phantombot -exec chown phantombot:phantombot '{}' +
	find /opt/PhantomBot_data \! -type l \! -user phantombot -exec chown phantombot:phantombot '{}' +
	exec setpriv --reuid phantombot --regid phantombot --init-groups "$0" "$@"
fi

# Link external custom modules into the install dir.
# Repo-shipped modules are baked into the image. Extra modules can be
# bind-mounted read-only at /opt/PhantomBot_external mirroring the install
# layout; each module dir is symlinked into place here at boot. A baked-in
# module of the same name wins (the external one is skipped with a warning).
# All PhantomBot custom-module discovery paths follow symlinks.
EXTERNAL_ROOT="/opt/PhantomBot_external"
CUSTOM_SUBTREES="scripts/custom scripts/discord/custom scripts/lang/custom web/panel/custom web/panel/pages/custom web/panel/js/pages/custom"

if [ -d "$EXTERNAL_ROOT" ]; then
	for subtree in $CUSTOM_SUBTREES; do
		src_dir="$EXTERNAL_ROOT/$subtree"
		dest_dir="/opt/PhantomBot/$subtree"
		[ -d "$src_dir" ] || continue
		mkdir -p "$dest_dir"
		for mod in "$src_dir"/*/; do
			[ -d "$mod" ] || continue
			name="$(basename "$mod")"
			target="$dest_dir/$name"
			if [ -e "$target" ] && [ ! -L "$target" ]; then
				echo "External module '$subtree/$name' skipped: a baked-in module of that name exists"
				continue
			fi
			ln -sfn "$mod" "$target"
			echo "Linked external module: $subtree/$name"
		done
	done
fi

exec "$@"
