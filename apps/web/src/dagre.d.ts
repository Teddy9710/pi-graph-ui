declare module "@dagrejs/dagre" {
	export interface DagreEdge {
		v: string;
		w: string;
		name?: string;
	}
	export interface GraphLabel {
		rankdir?: "TB" | "BT" | "LR" | "RL";
		nodesep?: number;
		ranksep?: number;
		edgesep?: number;
		marginx?: number;
		marginy?: number;
		[k: string]: unknown;
	}
	export class graphlib {
		static Graph: {
			new (opts?: { directed?: boolean; multigraph?: boolean; compound?: boolean }): {
				setGraph(label: GraphLabel): void;
				setDefaultEdgeLabel(factory: () => Record<string, unknown>): void;
				setNode(id: string, label: { width: number; height: number } & Record<string, unknown>): void;
				setEdge(e: DagreEdge): void;
				node(id: string): { x: number; y: number; width: number; height: number } | undefined;
				edges(): DagreEdge[];
				nodes(): string[];
			};
		};
	}
	export function layout(g: graphlib.Graph): void;
}
