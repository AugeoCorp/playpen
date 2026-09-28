// Every key, with one line each. The rules are in README.md under Config.
export default {
	// Guest-local copies of dirs or files: slow or platform-specific paths, and a .env kept out of the VM.
	masked: ["node_modules", ".venv", ".env"],

	// Run in the guest on create and after a rebuild. `playpen setup` re-runs them.
	setup: ["npm ci", "uv sync"],

	network: {
		// Hosts to reach, on top of the ones playpen ships. A name covers its subdomains.
		allow: [
			"kagi.com", // any port, public addresses only
			"postgres.mycompany.example:5432", // a database on your network: that port only, and it may resolve to a LAN address
			"localhost:11434", // your machine's port 11434, as host.playpen.internal:11434 in the guest
		],

		// Your machine's port 1234 at the guest's own localhost:4321. Implies "localhost:1234".
		ports: [{ host: 1234, guest: 4321 }],

		// "log" allows everything on the internet side and records it, for finding the list.
		// mode: "log",
	},
};
