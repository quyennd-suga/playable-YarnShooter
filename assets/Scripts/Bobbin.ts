import { _decorator, Component, MeshRenderer, Color, Material } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('Bobbin')
export class Bobbin extends Component {
    @property(MeshRenderer) public meshRenderer: MeshRenderer = null;
    
    private _mat: Material = null;

    onLoad() {
        if (this.meshRenderer) {
            // Lấy instance của material để đổi màu không làm ảnh hưởng các bobbin khác
            this._mat = this.meshRenderer.getMaterialInstance(0);
        }
    }

    public setColor(color: Color): void {
        if (this._mat) {
            this._mat.setProperty('albedoColor', color);
            // this._mat.setProperty('albedo', color); // Dành cho shader cũ nếu cần
        }
    }
}
