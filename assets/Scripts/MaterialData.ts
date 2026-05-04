import { _decorator, Color } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('MaterialData')
export class MaterialData {
    @property
    public id: number = -1;

    @property(Color)
    public color: Color = new Color(38, 38, 38, 255);

    constructor(id: number = -1, color: Color = new Color(38, 38, 38, 255)) {
        this.id = id;
        this.color = color.clone();
    }

    public static fromOther(other: MaterialData | null): MaterialData {
        const data = new MaterialData();
        if (other) {
            data.id = other.id;
            data.color = other.color.clone();
        }
        return data;
    }

    public static get empty(): MaterialData {
        return new MaterialData(-1, new Color(38, 38, 38, 255));
    }

    public clone(): MaterialData {
        return MaterialData.fromOther(this);
    }
}
