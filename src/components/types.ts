export type ParkItem = {
  name: string;
  osm_id: number;
  count: bigint;
  envelope: any;
};

export type Metadata = {
  created_at: string;
  files: {
    pmtiles: string;
    park_stats: string;
  };
  bbox: [number, number, number, number];
};
