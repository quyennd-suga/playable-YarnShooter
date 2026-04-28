Shader "Custom/ConveyorBelt"
{
    Properties
    {
        _BaseMap      ("Texture", 2D)    = "white" {}
        _BaseColor    ("Color", Color)   = (1,1,1,1)
        _ScrollSpeedX ("Scroll Speed X", Float) = 0.0
        _ScrollSpeedY ("Scroll Speed Y", Float) = -1.0
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" "Queue"="Geometry" }
        LOD 200

        // ── Forward Lit ───────────────────────────────────────────
        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex   vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile_fog

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_BaseMap);
            SAMPLER(sampler_BaseMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                half4  _BaseColor;
                float  _ScrollSpeedX;
                float  _ScrollSpeedY;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv         : TEXCOORD0;
                float3 normalWS   : TEXCOORD1;
                float  fogFactor  : TEXCOORD2;
            };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                VertexPositionInputs posInputs = GetVertexPositionInputs(IN.positionOS.xyz);
                OUT.positionCS = posInputs.positionCS;
                OUT.normalWS   = TransformObjectToWorldNormal(IN.normalOS);
                OUT.fogFactor  = ComputeFogFactor(posInputs.positionCS.z);

                float2 uv = TRANSFORM_TEX(IN.uv, _BaseMap);
                uv.x += _ScrollSpeedX * _Time.y;
                uv.y += _ScrollSpeedY * _Time.y;
                OUT.uv = uv;
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                half4 texColor = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, IN.uv);
                half4 color    = texColor * _BaseColor;

                Light  mainLight = GetMainLight();
                float3 normalWS  = normalize(IN.normalWS);
                float  NdotL     = saturate(dot(normalWS, mainLight.direction));
                color.rgb       *= mainLight.color * (NdotL * 0.8 + 0.2);
                color.rgb        = MixFog(color.rgb, IN.fogFactor);
                return color;
            }
            ENDHLSL
        }

        // ── Shadow Caster (tuỳ chỉnh, không alpha-clip) ───────────
        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }

            ZWrite On
            ZTest LEqual
            ColorMask 0

            HLSLPROGRAM
            #pragma vertex   vertShadow
            #pragma fragment fragShadow

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                half4  _BaseColor;
                float  _ScrollSpeedX;
                float  _ScrollSpeedY;
            CBUFFER_END

            float3 _LightDirection;

            struct AttributesShadow { float4 positionOS : POSITION; float3 normalOS : NORMAL; };
            struct VaryingsShadow   { float4 positionCS : SV_POSITION; };

            VaryingsShadow vertShadow(AttributesShadow IN)
            {
                VaryingsShadow OUT;
                float3 posWS    = TransformObjectToWorld(IN.positionOS.xyz);
                float3 normalWS = TransformObjectToWorldNormal(IN.normalOS);
                posWS           = ApplyShadowBias(posWS, normalWS, _LightDirection);
                OUT.positionCS  = TransformWorldToHClip(posWS);
                return OUT;
            }

            half4 fragShadow(VaryingsShadow IN) : SV_Target { return 0; }
            ENDHLSL
        }
    }

    FallBack "Hidden/Universal Render Pipeline/FallbackError"
}
