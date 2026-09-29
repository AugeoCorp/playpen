// Every key, with one line each. The rules are in README.md under Config.
export default {
	// Guest-local storage for paths that are slow or platform-specific on the share.
	masked: ["node_modules"],

	// Run in the guest on create and after a rebuild. `playpen setup` re-runs them.
	setup: ["npm ci"],

	network: {
		// Hosts to reach, on top of the ones playpen ships. A name covers its subdomains.
		allow: [
			"kagi.com", // any port, public addresses only
			"postgres.mycompany.example:5432", // a database on your network: that port only, and it may resolve to a LAN address
			"localhost:11434", // your machine's port 11434, as host.playpen.internal:11434 in the guest
		],

		// Your machine's port 1234 at the guest's own localhost:4321. Implies "localhost:1234".
		ports: [{ host: 1234, guest: 4321 }],

		// A credential from your environment for these hosts, by name only. Implies their allow entries; the guest holds a placeholder.
		secrets: [{ env: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }],

		// "log" allows everything on the internet side and records it, for finding the list.
		// mode: "log",
	},
};
