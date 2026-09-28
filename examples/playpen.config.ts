// An example playpen.config.ts showing every key. Copy it to your project's
// root and keep what applies. playpen prints the file and asks before running
// it, because it runs on your machine as you; only `setup` runs in the guest.
export default {
	// Project paths given guest-local storage instead of the shared mount.
	// Native modules and compiled environments are per platform, and the
	// share is slow. Masked is not hidden: the host copy stays underneath.
	masked: ["node_modules", ".venv"],

	// Run in the guest, in order, on create and after a rebuild; never on a
	// plain start. `playpen setup` runs them again. A login shell, so a
	// toolchain pinned in this directory's mise.toml is installed first.
	setup: ["npm ci", "uv sync"],

	network: {
		// Hosts this project may reach, on top of the ones playpen ships
		// (Anthropic's API, npm, GitHub, nodejs.org, PyPI). A name covers
		// everything under it, so "example.com" already includes
		// "api.example.com"; "*.example.com" is rejected as redundant.
		allow: [
			// The internet side: a name without a port, any port, public
			// addresses only.
			"registry.yarnpkg.com",
			// A name with a port matches that port alone and may resolve to a
			// LAN address as well, for a database on your network. Neither
			// kind ever reaches this machine.
			"db.internal.example:5432",
			// Your machine: port 11434 on the computer running playpen, an
			// Ollama here. Inside the guest, `localhost` is the guest, so it
			// asks for http://host.playpen.internal:11434/ instead. The port is
			// required; a bare "localhost" is rejected.
			"localhost:11434",
		],

		// Finding the list: "log" lets internet connections through and
		// records each one in $XDG_DATA_HOME/playpen/net/<sandbox>/gatekeeper.log
		// as a `report` line. Read them after a real session, move the hosts
		// into `allow`, then delete this. Your own machine stays closed in
		// every mode. The default is "enforce".
		// mode: "log",
	},
};
