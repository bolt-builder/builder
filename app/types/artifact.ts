export interface BoltArtifactData {
  id: string;
  title: string;
  type?: string | undefined;

  /** When true, files are already on disk (e.g. server-side git clone). */
  preloaded?: boolean;
}
