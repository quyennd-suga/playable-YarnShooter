import { Color } from 'cc';
import { MaterialData } from './MaterialData';
import { EMPTY_MATERIAL, MATERIAL_PALETTE } from './MaterialPaletteData';

const toColor = (hex: string) => Color.fromHEX(new Color(), hex);

const _emptyMaterial = new MaterialData(EMPTY_MATERIAL.id, toColor(EMPTY_MATERIAL.color));
const _materials: MaterialData[] = MATERIAL_PALETTE.map(m => new MaterialData(m.id, toColor(m.color)));
const _map = new Map<number, MaterialData>(_materials.map(m => [m.id, m]));

export const MaterialPalette = {
    get materials(): readonly MaterialData[] { return _materials; },
    get emptyMaterial(): MaterialData { return _emptyMaterial; },

    getMaterialById(id: number): MaterialData {
        return id < 0 ? _emptyMaterial : (_map.get(id) ?? _emptyMaterial);
    },

    getMaterialCount(): number { return _materials.length; },

    getNextId(): number {
        return _materials.reduce((max, m) => m.id > max ? m.id : max, -1) + 1;
    },
} as const;
