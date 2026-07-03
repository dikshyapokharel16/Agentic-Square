import sys
from pxr import Usd, UsdGeom

path = sys.argv[1]
stage = Usd.Stage.Open(path)
default_prim = stage.GetDefaultPrim()

xform_api = UsdGeom.XformCommonAPI(default_prim)
_, _, scale, _, _ = xform_api.GetXformVectors(Usd.TimeCode.Default())

bbox_cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_])
bbox = bbox_cache.ComputeWorldBound(default_prim).ComputeAlignedBox()
mn, mx = bbox.GetMin(), bbox.GetMax()
size = [round(mx[i] - mn[i], 3) for i in range(3)]

print(f"{path}")
print(f"  current scale op: {scale}")
print(f"  size (m): {size}")
