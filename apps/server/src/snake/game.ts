/**
 * Snake game core logic (framework-agnostic, no DOM).
 *
 * Kept as pure data + pure functions so the same logic can drive the
 * browser front-end and be thoroughly unit-tested on the server.
 *
 * Coordinate system: (x, y), 0-indexed grid of `SIZE` columns (x) by
 * `SIZE` rows (y). +x moves right, +y moves down.
 */

export interface Point {
	x: number;
	y: number;
}

export type Direction = "up" | "down" | "left" | "right";

export interface GameState {
	size: number;
	snake: Point[];
	direction: Direction;
	/** The direction that will take effect on the next tick. */
	pending: Direction;
	food: Point;
	score: number;
	over: boolean;
}

export const DEFAULT_SIZE = 20;

const DIR_VEC: Record<Direction, Point> = {
	up: { x: 0, y: -1 },
	down: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
};

/** Moving in the returned direction would collide with the current direction. */
const OPPOSITE: Record<Direction, Direction> = {
	up: "down",
	down: "up",
	left: "right",
	right: "left",
};

export function initialGame(size = DEFAULT_SIZE): GameState {
	const snake = [{ x: Math.floor(size / 2), y: Math.floor(size / 2) }];
	const food = spawnFoodStrict(makeOccupied(snake), size) ?? { x: 1, y: 1 };
	return {
		size,
		snake,
		direction: "right",
		pending: "right",
		food,
		score: 0,
		over: false,
	};
}

/** Ordered set-ish lookup for positions the snake currently occupies. */
export function makeOccupied(snake: Point[]): Set<string> {
	const set = new Set<string>();
	for (const p of snake) set.add(keyOf(p));
	return set;
}

export function keyOf(p: Point): string {
	return `${p.x},${p.y}`;
}

function inBounds(p: Point, size: number): boolean {
	return p.x >= 0 && p.x < size && p.y >= 0 && p.y < size;
}

/**
 * Pick a random free cell on the board.
 * Returns undefined if the board is full (snake won).
 */
export function spawnFoodStrict(occupied: Set<string>, size: number): Point | undefined {
	const free: Point[] = [];
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (!occupied.has(keyOf({ x, y }))) free.push({ x, y });
		}
	}
	if (free.length === 0) return undefined;
	return free[Math.floor(Math.random() * free.length)];
}

/**
 * Queue the next direction. Rejects reversing into the current direction and
 * invalid values by returning the previous state unchanged.
 */
export function turn(state: GameState, next: unknown): GameState {
	if (next === "up" || next === "down" || next === "left" || next === "right") {
		if (next === OPPOSITE[state.direction]) return state;
		return { ...state, pending: next };
	}
	return state;
}

/**
 * Advance the game one tick. Returns a *new* state; the previous state is
 * never mutated. Collision with wall/self ends the game, eating food grows
 * the snake and increments score.
 */
export function step(state: GameState): GameState {
	if (state.over) return state;
	const dir = state.pending;
	const vec = DIR_VEC[dir];
	const head = state.snake[0];
	if (!head) return state; // degenerate: no snake cells
	const nextHead = { x: head.x + vec.x, y: head.y + vec.y };

	if (!inBounds(nextHead, state.size)) {
		return { ...state, over: true };
	}

	const occupied = makeOccupied(state.snake);
	// Self-collision: the tail cell is vacated this tick unless we grow.
	const growing = nextHead.x === state.food.x && nextHead.y === state.food.y;
	const collision = occupied.has(keyOf(nextHead)) && !(isTail(state.snake, nextHead) && !growing);
	if (collision) {
		return { ...state, over: true };
	}

	const snake = [nextHead, ...state.snake];
	if (growing) {
		const food = spawnFoodStrict(makeOccupied(snake), state.size);
		return {
			...state,
			snake,
			food: food ?? nextHead, // board full: keep last cell (game effectively won at max size)
			score: state.score + 1,
			direction: dir,
			over: food === undefined,
		};
	}
	snake.pop();
	return { ...state, snake, direction: dir };
}

function isTail(snake: Point[], head: Point): boolean {
	const tail = snake[snake.length - 1];
	return tail !== undefined && tail.x === head.x && tail.y === head.y;
}

/** Total food eaten is the score; full board means max achievable score. */
export function maxScore(size: number): number {
	return size * size - 1;
}
