import type { ConnectionsInfo, PortInfo } from "../../domain/agent";

export const SSH_PORT = 22;

// Розбирає вміст /proc/net/tcp (і tcp6): рядок «sl local rem st …», порти в hex, стан 0A = слухає, 01 = з'єднання встановлене.
export function parseConnections(procNet: string, opencodePort: number): Omit<ConnectionsInfo, "running"> {
	const count = (): PortInfo => ({ listening: false, connections: 0 });
	const ssh = count();
	const opencode = count();
	for (const line of procNet.split("\n")) {
		const cols = line.trim().split(/\s+/);
		const local = cols[1]?.split(":")[1];
		const state = cols[3];
		if (!local || !state) continue;
		const info = parseInt(local, 16) === SSH_PORT ? ssh : parseInt(local, 16) === opencodePort ? opencode : undefined;
		if (!info) continue;
		if (state === "0A") info.listening = true;
		else if (state === "01") info.connections++;
	}
	return { ssh, opencode };
}
