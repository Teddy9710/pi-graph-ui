import { describe, expect, it } from "vitest";
import {
	initialGame,
	step,
	turn,
	keyOf,
	makeOccupied,
	spawnFoodStrict,
	maxScore,
	type GameState,
} from "../../src/snake/game.ts";

/** Build a board of given size with the snake at these exact cells. */
function stateWithSnake(snake: GameState["snake"], size = 20): GameState {
	const s = initialGame(size);
	return {
		...s,
		snake,
		size,
		food: foodOnFreeCell(size, snake),
		direction: "right",
		pending: "right",
		score: Math.max(0, snake.length - 1),
	};
}

/** Place food on a cell the snake doesn't occupy. */
function foodOnFreeCell(size: number, snake: GameState["snake"]) {
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++)
			if (!snake.some((s) => s.x === x && s.y === y)) return { x, y };
	return { x: 0, y: 0 };
}

describe("keyOf / makeOccupied", () => {
	it("encodes cell coordinates deterministically", () => {
		expect(keyOf({ x: 3, y: 7 })).toBe("3,7");
	});
	it("builds a lookup set from snake cells", () => {
		const set = makeOccupied([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
		expect(set.has("0,0")).toBe(true);
		expect(set.has("1,0")).toBe(true);
		expect(set.has("2,0")).toBe(false);
	});
});

describe("spawnFoodStrict", () => {
	it("returns a cell not occupied by the snake", () => {
		const occupied = makeOccupied([{ x: 5, y: 5 }]);
		const food = spawnFoodStrict(occupied, 5);
		expect(food).toBeDefined();
		expect(occupied.has(keyOf(food!))).toBe(false);
	});
	it("returns undefined when the board is full", () => {
		const size = 3;
		const all = [];
		for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) all.push({ x, y });
		expect(spawnFoodStrict(makeOccupied(all), size)).toBeUndefined();
	});
});

describe("turn", () => {
	it("accepts a valid direction", () => {
		const s = initialGame();
		const next = turn(s, "up");
		expect(next.pending).toBe("up");
		// original is not mutated
		expect(s.pending).toBe("right");
	});
	it("rejects a reverse into the current direction", () => {
		const s = initialGame();
		const next = turn(s, "left");
		expect(next.pending).toBe("right");
	});
	it("ignores invalid direction values", () => {
		const s = initialGame();
		expect(turn(s, "diagonal").pending).toBe("right");
		expect(turn(s, null).pending).toBe("right");
		expect(turn(s, 42).pending).toBe("right");
	});
	it("allows a 90-degree turn", () => {
		const s = initialGame();
		expect(turn(s, "down").pending).toBe("down");
	});
});

describe("step", () => {
	it("advances the snake forward and does not mutate input", () => {
		const a = initialGame(6);
		const origHead = { ...a.snake[0] };
		const before = a.snake.length;
		const b = step(a);
		expect(a.snake[0]).toEqual(origHead); // input untouched
		expect(b.snake.length).toBe(before);   // no growth
		expect(b.snake[0]).toEqual({ x: origHead.x + 1, y: origHead.y });
	});

	it("handles head-start position correctly at origin with pending right", () => {
		const s = stateWithSnake([{ x: 2, y: 2 }], 10);
		const b = step(s);
		expect(b.snake[0]).toEqual({ x: 3, y: 2 });
	});

	it("grows and increments score when eating food", () => {
		const s = stateWithSnake([{ x: 2, y: 2 }], 10);
		const growing = { ...s, food: { x: 3, y: 2 } };
		const b = step(growing);
		expect(b.score).toBe(growing.score + 1);
		expect(b.snake.length).toBe(growing.snake.length + 1);
		expect(b.snake[0]).toEqual({ x: 3, y: 2 });
		// new food must not sit on the snake
		expect(makeOccupied(b.snake).has(keyOf(b.food))).toBe(false);
	});

	it("ends the game on wall collision", () => {
		const s = { ...initialGame(5), snake: [{ x: 4, y: 0 }], pending: "right" as const };
		expect(step(s).over).toBe(true);
	});

	it("ends the game on self collision (head into body)", () => {
		const snake = [
			{ x: 2, y: 2 },
			{ x: 1, y: 2 },
			{ x: 1, y: 3 },
			{ x: 2, y: 3 },
			{ x: 2, y: 2 }, // cycle
		];
		// Head at (2,2) moving right would enter (3,2) which is empty — so to force
		// a self collision, point the head at an occupied body cell instead.
		const s = { ...stateWithSnake(snake, 5), pending: "down" as const };
		// (2,2)+down=(2,3) is occupied by the body => self collision.
		expect(step(s).over).toBe(true);
	});

	it("does NOT self-collide with the vacating tail on a non-eating move", () => {
		// Head moves into where the tail currently is; tail vacates -> legal.
		const s = {
			...stateWithSnake([{ x: 1, y: 0 }, { x: 0, y: 0 }], 5),
			pending: "left" as const, // (1,0)+left=(0,0), which is the tail
		};
		const b = step(s);
		expect(b.over).toBe(false);
	});

	it("does not move after game over", () => {
		const over = { ...initialGame(), over: true };
		const b = step(over);
		expect(b).toBe(over);
	});
});

describe("maxScore", () => {
	it("equals cells minus the starting single cell", () => {
		expect(maxScore(20)).toBe(399);
		expect(maxScore(5)).toBe(24);
	});
});
