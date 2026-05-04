import { _decorator, Component, JsonAsset, Prefab, Node, instantiate } from 'cc';
import { MaterialPalette } from './MaterialPalette';
import { BoardScaler } from './BoardScaler';
import { Yarn } from './Yarn';

const { ccclass, property } = _decorator;

interface PixelData {
    x: number;
    y: number;
    material: number;
}

interface PixelImage {
    pixels: PixelData[];
}

interface LevelData {
    PixelImage: PixelImage;
}

@ccclass('MapGenerator')
export class MapGenerator extends Component {

    @property(JsonAsset)    public levelData:   JsonAsset   = null;
    @property(Prefab)       public knitPrefab:  Prefab      = null;
    @property(Node)         public aboveParent: Node        = null;
    @property(BoardScaler)  public boardScaler: BoardScaler = null;

    start() {
        this.generateMap();
    }

    public generateMap(): void {
        this.clearMap();

        const data   = this.levelData.json as LevelData;
        const pixels = data.PixelImage.pixels;

        this.boardScaler.calculateCenter(pixels);

        const parent = this.aboveParent ?? this.node;

        for (let i = 0; i < pixels.length; i++) {
            const pixel = pixels[i];
            const node  = instantiate(this.knitPrefab);
            parent.addChild(node);

            const pos = this.boardScaler.getChildLocalPosition(pixel.x, pixel.y);
            node.setPosition(pos.x, pos.y, pos.z);

            node.getComponent(Yarn)?.setColor(MaterialPalette.getMaterialById(pixel.material).color);
        }

        this.boardScaler.adjustScale();
    }

    public clearMap(): void {
        (this.aboveParent ?? this.node).removeAllChildren();
    }
}
