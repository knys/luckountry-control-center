export class InterruptibleWait {
  private timer: NodeJS.Timeout | undefined;
  private resolve: (() => void) | undefined;

  wait(milliseconds: number): Promise<void> {
    this.cancel();
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
      this.timer = setTimeout(() => this.finish(), milliseconds);
    });
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.finish();
  }

  private finish(): void {
    this.timer = undefined;
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.();
  }
}
