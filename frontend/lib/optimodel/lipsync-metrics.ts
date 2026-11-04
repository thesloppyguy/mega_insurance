/**
 * Opt-in A/V sync diagnostics for the OptiModel avatar.
 * Enable in the browser console: localStorage.optimodelDebug = "1" (then reload).
 */
export function lipsyncDebugEnabled(): boolean {
	try {
		return (
			typeof window !== "undefined" &&
			window.localStorage.getItem("optimodelDebug") === "1"
		);
	} catch {
		return false;
	}
}

export function lipsyncMark(
	event: string,
	data: Record<string, unknown> = {},
): void {
	if (!lipsyncDebugEnabled()) return;
	console.debug(
		`[optimodel-sync] ${performance.now().toFixed(1)}ms ${event}`,
		data,
	);
}

/** Rolling render stats, flushed to the console every `windowMs` while speaking. */
export class RenderStats {
	private frames = 0;
	private loops = 0;
	private skipped = 0;
	private sumMs = 0;
	private maxMs = 0;
	private windowStart = performance.now();

	constructor(private readonly windowMs = 2000) {}

	loop(): void {
		this.loops++;
	}

	skip(): void {
		this.skipped++;
	}

	rendered(ms: number): void {
		this.frames++;
		this.sumMs += ms;
		if (ms > this.maxMs) this.maxMs = ms;
	}

	flush(speaking: boolean): void {
		const now = performance.now();
		const elapsed = now - this.windowStart;
		if (elapsed < this.windowMs) return;
		if (speaking) {
			lipsyncMark("render-stats", {
				rafFps: +((this.loops * 1000) / elapsed).toFixed(1),
				renderFps: +((this.frames * 1000) / elapsed).toFixed(1),
				skippedInFlight: this.skipped,
				avgRenderMs: +(this.sumMs / Math.max(1, this.frames)).toFixed(
					2,
				),
				maxRenderMs: +this.maxMs.toFixed(2),
			});
		}
		this.frames = 0;
		this.loops = 0;
		this.skipped = 0;
		this.sumMs = 0;
		this.maxMs = 0;
		this.windowStart = now;
	}
}
