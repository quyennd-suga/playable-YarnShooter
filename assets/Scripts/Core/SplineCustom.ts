import { _decorator, Component, Node, Vec3, CCFloat } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('SplineCustom')
export class SplineCustom extends Component {
    @property(Node) public splineParent: Node = null;
    @property public speed: number = 1.5;

    @property({ type: [Node], tooltip: "Kéo thả các Node đại diện cho các góc của băng chuyền vào đây" })
    public wpsNodes: Node[] = [];

    @property({ type: [Vec3], readonly: true, tooltip: "Danh sách toạ độ tự động lấy từ wpsNodes (Chỉ đọc)" })
    public wps: Vec3[] = [];

    @property({ type: CCFloat, readonly: true, tooltip: "Tổng chiều dài đường đi" })
    public pathLen: number = 0;

    @property({ type: [CCFloat], readonly: true, tooltip: "Chiều dài của từng đoạn (Segments)" })
    public segLens: number[] = [];

    public rebuild() {
        this.wps = [];
        this.segLens = [];
        this.pathLen = 0;

        for (let i = 0; i < this.wpsNodes.length; i++) {
            if (this.wpsNodes[i]) {
                this.wps.push(this.wpsNodes[i].worldPosition.clone());
            }
        }

        for (let i = 0; i < this.wps.length - 1; i++) {
            let dist = Vec3.distance(this.wps[i], this.wps[i+1]);
            this.segLens.push(dist);
            this.pathLen += dist;
        }
    }
}
