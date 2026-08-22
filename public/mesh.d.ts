export type MeshLevel = "mesh3" | "mesh4" | "mesh5";

export interface MeshCodes {
	mesh3: string;
	mesh4: string;
	mesh5: string;
}

export interface MeshBounds {
	latMin: number;
	latMax: number;
	lngMin: number;
	lngMax: number;
}

export function meshCodes(lat: number, lng: number): MeshCodes;

export function meshBounds(code: string): MeshBounds;

export function meshGridCount(
	minLat: number,
	minLng: number,
	maxLat: number,
	maxLng: number,
	level: MeshLevel,
): number;

export function meshGrid(
	minLat: number,
	minLng: number,
	maxLat: number,
	maxLng: number,
	level: MeshLevel,
): string[];