"""ULTRA 3D RECONSTRUCTOR — reconstrucción y restauración de modelos 3D.

Se instala en Blender como cualquier add-on (Editar → Preferencias →
Complementos → Instalar, apuntando al ZIP de esta carpeta) y aparece en el
panel lateral del visor 3D (tecla N), pestaña "ULTRA 3D".

El paquete `core` es Python puro y se importa igual fuera de Blender, que
es lo que permite correr su batería de tests sin abrir el programa:

    python3 -m unittest discover -s tests
"""

from __future__ import annotations

bl_info = {
    "name": "ULTRA 3D RECONSTRUCTOR",
    "author": "Proyecto Jornada Territorial — Zapicán",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "Vista 3D > Panel lateral (N) > ULTRA 3D",
    "description": (
        "Reconstruye, restaura y optimiza modelos 3D midiendo: clasifica el "
        "modelo, elige la técnica que corresponde, verifica la fidelidad "
        "contra el original y genera LODs con mapas horneados."
    ),
    "warning": "El proceso completo puede tardar y pide bastante RAM.",
    "category": "Mesh",
}

try:
    import bpy  # noqa: F401

    IN_BLENDER = True
except ImportError:
    # Fuera de Blender solo se puede usar `core`, que no depende de bpy.
    IN_BLENDER = False

if IN_BLENDER:
    from . import ui

    def register():
        ui.register()

    def unregister():
        ui.unregister()
else:  # pragma: no cover - solo para importar el paquete desde los tests
    def register():
        raise RuntimeError("Este add-on necesita Blender para registrarse.")

    def unregister():
        raise RuntimeError("Este add-on necesita Blender para registrarse.")
