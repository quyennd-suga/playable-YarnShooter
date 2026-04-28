using UnityEngine;

[RequireComponent(typeof(Renderer))]
public class ConveyorBeltUVScroll : MonoBehaviour
{
    [SerializeField] private float scrollSpeedX = 0f;
    [SerializeField] private float scrollSpeedY = -1f;

    private Renderer _renderer;
    private MaterialPropertyBlock _mpb;
    private Vector2 _offset;
    private Vector2 _scale;

    void Awake()
    {
        _renderer = GetComponent<Renderer>();
        _mpb = new MaterialPropertyBlock();
        _scale = _renderer.sharedMaterial.GetTextureScale("_BaseMap");
    }

    void Update()
    {
        _offset.x += scrollSpeedX * Time.deltaTime;
        _offset.y += scrollSpeedY * Time.deltaTime;

        _renderer.GetPropertyBlock(_mpb);
        _mpb.SetVector("_BaseMap_ST", new Vector4(_scale.x, _scale.y, _offset.x % 1f, _offset.y % 1f));
        _renderer.SetPropertyBlock(_mpb);
    }
}
