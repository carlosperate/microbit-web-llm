/**
 * Bounded watchdog for the iframe's initial load. Fires onTimeout once if
 * notifyReady() is not called within timeoutMs. After fire, dispose, or
 * notifyReady the watchdog is permanently inert.
 */
export class LoadWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: (reason: string) => void,
  ) {}

  start(): void {
    if (this.settled || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.settled) return;
      this.settled = true;
      this.onTimeout(
        `MakeCode editor did not load within ${this.timeoutMs}ms`,
      );
    }, this.timeoutMs);
  }

  notifyReady(): void {
    this.settled = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.settled = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
