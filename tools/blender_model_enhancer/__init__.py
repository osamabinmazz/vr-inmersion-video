"""3D Model Enhancer — mejora asistida de modelos para VR educativa.

Punto de entrada del addon. Blender importa este módulo al activarlo y
llama a register().

El sistema está en tres capas:

  core/      decisiones puras (sin bpy) — qué conviene hacerle al modelo.
             Tiene tests que corren fuera de Blender.
  analysis   medición sobre la escena (bmesh, BVHTree).
  pipeline   operaciones destructivas, siempre sobre duplicados.
  ui         panel, operadores e informe.

La separación no es capricho: la lógica que decide entre subdividir,
remeshear o solo hornear mapas es la parte que hay que poder verificar, y
dentro de Blender no se puede testear automáticamente.
"""

bl_info = {
    "name": "3D Model Enhancer",
    "author": "VR Inmersión — Jornada Zapicán",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar (N) > 3D Model Enhancer",
    "description": (
        "Analiza un modelo y genera MASTER_HIGH + LOD0/1/2 con bake de "
        "normal/AO/displacement, controlando que no se pierda la forma original"
    ),
    "category": "Object",
}

# Recarga en caliente: sin esto, volver a activar el addon tras editar un
# módulo deja en memoria la versión vieja y uno termina depurando fantasmas.
if "_LOADED" in locals():
    import importlib

    for _name in ("analysis", "pipeline", "ui"):
        _mod = locals().get(_name)
        if _mod is not None:
            importlib.reload(_mod)

_LOADED = True

# El paquete tiene que poder importarse FUERA de Blender: los tests de core/
# corren con python3 a secas, y si acá hubiera un `import bpy` incondicional
# ni siquiera se podrían cargar. Por eso la capa de UI se importa solo
# cuando bpy existe de verdad.
try:
    import bpy  # noqa: F401

    IN_BLENDER = True
except ImportError:  # pragma: no cover - solo ocurre fuera de Blender
    IN_BLENDER = False

if IN_BLENDER:
    from . import ui

    def register():
        ui.register()

    def unregister():
        ui.unregister()

else:

    def register():
        raise RuntimeError(
            "3D Model Enhancer necesita ejecutarse dentro de Blender "
            "(no se encontró el módulo bpy)."
        )

    unregister = register


if __name__ == "__main__":
    register()
