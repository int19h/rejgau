/** Ingestion and background work keep separate order. Reset waits for both. */
export class ArchiveLifecycle {
  private ingestTail: Promise<void> = Promise.resolve();
  private workTail: Promise<void> = Promise.resolve();
  private barrier: Promise<void> = Promise.resolve();

  ingest<T>(operation: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.barrier, this.ingestTail]).then(operation);
    this.ingestTail = result.then(() => {}, () => {});
    return result;
  }

  work<T>(operation: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.barrier, this.workTail]).then(operation);
    this.workTail = result.then(() => {}, () => {});
    return result;
  }

  control(operation: () => void): Promise<void> { return this.barrier.then(operation); }

  drainWork(): Promise<void> { return this.work(async () => {}); }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.barrier, this.ingestTail, this.workTail]).then(operation);
    this.barrier = result.then(() => {}, () => {});
    this.ingestTail = this.barrier;
    this.workTail = this.barrier;
    return result;
  }
}
