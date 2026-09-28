// Every key, with one line each. The rules are in README.md under Config.
export default {
	// Guest-local storage for paths that are slow or platform-specific on the share.
	masked: ["node_modules", ".venv"],

	// Run in the guest on create and after a rebuild. `playpen setup` re-runs them.
	setup: ["npm ci", "uv sync"],

	network: {
		// Hosts to reach, on top of the ones playpen ships. A name covers its subdomains.
		allow: [
			"registry.yarnpkg.com", // any port, public addresses only
			"db.internal.example:5432", // that port only; may be a LAN address
			"localhost:11434", // your machine's port 11434, as host.playpen.internal:11434 in the guest
		],

		// Your machine's port 1234 at the guest's own localhost:4321. Implies "localhost:1234".
		ports: [{ host: 1234, guest: 4321 }],

		// "log" allows everything on the internet side and records it, for finding the list.
		// mode: "log",
	},
};
