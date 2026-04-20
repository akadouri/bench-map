export type ParkItem = {
  name: string;
  area_id: number;
  count: bigint;
  envelope: any;
  state: string;
  city: string;
};

export type Metadata = {
  created_at: string;
  files: {
    pmtiles: string;
    park_stats: string;
  };
  bbox: [number, number, number, number];
};
