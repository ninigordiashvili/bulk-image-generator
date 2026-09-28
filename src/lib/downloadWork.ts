import type { WorkStatus } from "@/types/work";

export interface FileDownloadProgress {
  current: number;
  total: number;
}

/** Hand each attachment to the browser without buffering or packing the batch. */
export async function downloadWorkFiles(id: string, onProgress?: (progress: FileDownloadProgress) => void): Promise<void> {
  const response = await fetch(`/api/work/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error("Could not load this batch. Try again.");
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "Batch unavailable.");
  const batch = data.status as WorkStatus;
  if (batch.phase !== "done") throw new Error("Wait until this batch finishes before downloading all files.");
  const files = batch.jobs.filter(job => job.status === "success").flatMap(job => job.files ?? []);
  if (!files.length) throw new Error("This batch has no completed files to download.");
  onProgress?.({ current: 0, total: files.length });
  for (const [index, file] of files.entries()) {
    const url = new URL(file.url, window.location.origin);
    url.searchParams.set("download", "1");
    const link = document.createElement("a");
    link.href = url.href;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    onProgress?.({ current: index + 1, total: files.length });
    // Space out browser handoffs. The file route records each completed transfer;
    // never mark the entire batch downloaded merely because links were clicked.
    if (index < files.length - 1) await new Promise(resolve => setTimeout(resolve, 500));
  }
}
