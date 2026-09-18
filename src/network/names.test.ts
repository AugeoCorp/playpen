import assert from "node:assert/strict";
import { test } from "node:test";
import { isLanIpv4, isPublicIpv4, isReachableIpv4 } from "./names.ts";

test("a public address is both public and reachable", () => {
	assert.equal(isPublicIpv4("93.184.216.34"), true);
	assert.equal(isReachableIpv4("93.184.216.34"), true);
});

test("a LAN address is reachable, since a ported entry may dial one, but never public", () => {
	for (const address of [
		"192.168.1.50",
		"10.0.0.7",
		"172.16.5.4",
		"100.64.0.1",
	]) {
		assert.equal(
			isLanIpv4(address),
			true,
			`${address} should be a LAN address`,
		);
		assert.equal(
			isPublicIpv4(address),
			false,
			`${address} should not be public`,
		);
		assert.equal(
			isReachableIpv4(address),
			true,
			`${address} should be reachable`,
		);
	}
});

test("this machine's own loopback is reachable, since a ported entry may dial it, but never public", () => {
	assert.equal(isPublicIpv4("127.0.0.1"), false);
	assert.equal(isReachableIpv4("127.0.0.1"), true);
});

test("link-local, the 0.0.0.0 spelling of loopback, multicast and the reserved range are never reachable, ported entry or not", () => {
	for (const address of [
		"169.254.169.254",
		"0.0.0.0",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
	]) {
		assert.equal(
			isPublicIpv4(address),
			false,
			`${address} should not be public`,
		);
		assert.equal(
			isReachableIpv4(address),
			false,
			`${address} should not be reachable`,
		);
	}
});

test("a string that is not an IPv4 address is neither public nor reachable", () => {
	assert.equal(isPublicIpv4("not-an-ip"), false);
	assert.equal(isReachableIpv4("not-an-ip"), false);
});
