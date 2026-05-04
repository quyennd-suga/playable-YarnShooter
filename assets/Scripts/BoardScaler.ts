import { _decorator, Component, Node, Vec3 } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('BoardScaler')
export class BoardScaler extends Component {

    @property public cellSize:       number = 0.1;
    @property public viewportWidth:  number = 23;
    @property public viewportHeight: number = 30;

    @property(Node) public aboveParent: Node = null;

    private _minX:    number = 0;
    private _maxX:    number = 0;
    private _minY:    number = 0;
    private _maxY:    number = 0;
    private _centerX: number = 0;
    private _centerY: number = 0;

    public calculateCenter(pixels: Array<{ x: number; y: number }>): void {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        for (let i = 0; i < pixels.length; i++) {
            const px = pixels[i].x;
            const py = pixels[i].y;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }

        this._minX    = minX;
        this._maxX    = maxX;
        this._minY    = minY;
        this._maxY    = maxY;
        this._centerX = (minX + maxX) * 0.5;
        this._centerY = (minY + maxY) * 0.5;
    }

    public adjustScale(): void {
        const width  = this._maxX - this._minX;
        const height = this._maxY - this._minY;
        if (width === 0 || height === 0) return;

        const scale = Math.min(this.viewportWidth / width, this.viewportHeight / height);
        this.aboveParent.setScale(scale, scale, scale);
    }

    public getChildLocalPosition(pixelX: number, pixelY: number): Vec3 {
        return new Vec3(
            -(pixelX - this._centerX) * this.cellSize,
            0,
             (pixelY - this._centerY) * this.cellSize
        );
    }

    public get centerX(): number { return this._centerX; }
    public get centerY(): number { return this._centerY; }
}
