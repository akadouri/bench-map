import type { DatasetManifestSchema } from "@/types/generated";

export type BBox = [number, number, number, number];

/**
 * The parts of a dataset's `metadata.json` that the app reads, taken from the
 * generated manifest type. Only `name` and `created_at` are required, so partial
 * datasets (such as the demo, which has no boundary rankings) still load.
 */
export type Metadata = Pick<DatasetManifestSchema, "name" | "created_at"> &
  Partial<Pick<DatasetManifestSchema, "layers" | "composites" | "artifacts">>;
