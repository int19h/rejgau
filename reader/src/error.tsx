import { DataError } from "./data";

export function LoadError({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  const reload = error instanceof DataError && error.reload;
  return (
    <div class="empty load-error" role="alert">
      <p>{message}</p>
      {reload ? <button onClick={() => location.reload()}>Reload archive</button> : retry ? <button onClick={retry}>Try again</button> : null}
    </div>
  );
}
