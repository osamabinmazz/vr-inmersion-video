# 3D Model Enhancer

Addon de Blender que toma un modelo existente (OBJ, FBX, GLB/glTF, STL, BLEND) y genera versiones de mayor calidad visual más una cadena de LODs optimizados para VR, **sin alterar el original**.

La premisa del diseño: *más polígonos no es más detalle*. El sistema mide el modelo primero y decide qué operación aporta de verdad; si el modelo ya es denso, no lo subdivide — recupera detalle desde las texturas.

---

## Instalación

### Opción A — como addon (recomendada)

1. Comprimí la carpeta `blender_model_enhancer/` en un ZIP. El ZIP tiene que contener la **carpeta**, no sus archivos sueltos:

   ```
   blender_model_enhancer.zip
   └── blender_model_enhancer/
       ├── __init__.py
       ├── analysis.py
       ├── pipeline.py
       ├── ui.py
       └── core/
   ```

   Desde la terminal, parado en `tools/`:
   ```bash
   zip -r blender_model_enhancer.zip blender_model_enhancer -x "*__pycache__*" -x "*/tests/*"
   ```

2. En Blender: **Edit > Preferences > Add-ons > Install…**, elegí el ZIP.
3. Buscá "3D Model Enhancer" en la lista y **marcá la casilla** para activarlo.
4. En el viewport, apretá **N** para abrir la barra lateral. Va a aparecer una pestaña **3D Model Enhancer**.

### Opción B — copiar a la carpeta de addons

Copiá la carpeta `blender_model_enhancer/` a:

| Sistema | Ruta |
|---|---|
| Windows | `%APPDATA%\Blender Foundation\Blender\<versión>\scripts\addons\` |
| macOS | `~/Library/Application Support/Blender/<versión>/scripts/addons/` |
| Linux | `~/.config/blender/<versión>/scripts/addons/` |

Reiniciá Blender y activalo en Preferences > Add-ons.

### Opción C — desde el editor de Scripting (para probar rápido)

En **Scripting > New**, pegá esto y apretá *Run Script*:

```python
import sys, importlib
RUTA = r"/ruta/absoluta/a/tools"   # ← la carpeta que CONTIENE blender_model_enhancer
if RUTA not in sys.path:
    sys.path.append(RUTA)

import blender_model_enhancer
importlib.reload(blender_model_enhancer)
blender_model_enhancer.register()
```

---

## Uso

Seleccioná un objeto de malla y abrí **N > 3D Model Enhancer**.

### Camino rápido

**AUTO ENHANCE SELECTED MODEL** hace todo: analiza, respalda, limpia, construye el MASTER_HIGH, genera LOD0/1/2, hornea los mapas, verifica que no se haya perdido la forma y escribe el informe.

### Botón por botón

| Botón | Qué hace |
|---|---|
| **ANALIZAR MODELO** | Mide la malla y muestra el plan propuesto. No modifica nada. |
| **CREAR BACKUP** | Copia intacta en `00_ORIGINAL`. |
| **MEJORAR GEOMETRÍA** | Limpia duplicados, vértices sueltos y caras internas; recalcula normales; aplica Weighted Normals. |
| **CREAR MASTER HIGH** | Versión de máxima calidad, con la estrategia que decidió el análisis. |
| **LOD0 / LOD1 / LOD2** | Decima el master hasta el objetivo de cada nivel. |
| **GENERAR NORMAL MAP** | Hornea solo el normal del master al LOD elegido. |
| **GENERAR DISPLACEMENT** | Ídem para displacement. |
| **BAKEAR TEXTURAS** | Normal + AO + displacement de una. |
| **COMPARAR MODELOS** | Tabla de desviación de silueta y volumen de cada nivel contra el original. |
| **EXPORTAR** | GLB / glTF / FBX / OBJ / BLEND del nivel elegido. |

El informe se escribe en un datablock de texto llamado `MODEL_ENHANCER_REPORT` (abrilo desde el editor de Texto) y también sale por la consola del sistema.

### Colecciones que crea

```
00_ORIGINAL     copia intacta, oculta al render
01_MASTER_HIGH  versión de máxima calidad
02_LOD0         primeros planos
03_LOD1         distancia media
04_LOD2         lejanía
05_BAKES        reservada para los mapas
06_EXPORTS      reservada para exportaciones
```

---

## Cómo decide

`core/metrics.py` clasifica el modelo en dos ejes y de ahí sale la estrategia:

**Densidad** → very_low (<1k tris) · low (<15k) · medium (<120k) · high (<800k) · very_high (≥800k)

**Topología** → clean · acceptable · poor · broken, según proporción de non-manifold, ngons, duplicados y caras internas.

| Situación | Estrategia | Por qué |
|---|---|---|
| Topología limpia, quads, con UVs | **Multires** | Permite subdividir y luego hornear del nivel alto al bajo conservando el mapeo. |
| Topología limpia sin UVs | **Subdivision Surface** | Igual de válido, pero hay que desplegar UVs antes de bakear. |
| Topología pobre o rota | **Voxel Remesh + Shrinkwrap** | Subdividir sobre non-manifold produce picos y superficies derretidas. Se genera superficie nueva y se recupera la silueta proyectándola contra el original. |
| Ya es muy denso (escaneo) | **Detail Only** | Subdividir no agrega información, agrega peso. El detalle viene de los mapas. |

Los objetivos de triángulos se adaptan: un arbusto de 800 tris no recibe un master de 3M, y un escaneo de 2M sí usa el presupuesto completo.

El `voxel_size` del remesh se deriva del área de superficie real del objeto, no es un valor fijo — el mismo valor que detalla un insecto convierte un árbol en una mancha.

---

## Control de fidelidad

Después de cada nivel, se mide con un `BVHTree` la distancia de cada vértice del resultado a la superficie del original, **expresada como fracción de la diagonal del bounding box**. Así el criterio vale igual para un tero de 30 cm que para un ombú de 12 m.

| Veredicto | Desvío medio | Cambio de volumen |
|---|---|---|
| `pass` | ≤ 0.4% | ≤ 3% |
| `acceptable` | ≤ 1.2% | ≤ 8% |
| `degraded` | ≤ 3.5% | ≤ 20% |
| `failed` | más | más |

Si el MASTER_HIGH sale `degraded` o `failed`, el sistema **rehace el nivel con menos intensidad** (voxel más grueso, menos subdivisión) en lugar de entregar un modelo deformado. Son hasta 2 reintentos por defecto, configurable en el panel.

Se usa el percentil 95 y no el máximo: un vértice suelto disparado no debería condenar un resultado que en general es fiel.

---

## Qué protege

- El original **nunca** se modifica: toda operación destructiva ocurre sobre duplicados.
- Con **armature** o **shape keys** no se aplican modificadores de forma destructiva (rompería el skinning y las claves). El informe avisa y recomienda transferir pesos.
- Los **bordes abiertos no se cierran**: en vegetación las hojas y alpha cards son superficies abiertas a propósito, y taparlas arruina el asset.
- Decimate se usa **solo** en los LODs, nunca en el master ni el original.

---

## Tests

La lógica de decisión no depende de Blender, así que se puede verificar con Python a secas:

```bash
cd tools
python3 -m unittest discover -s blender_model_enhancer/tests -t .
```

52 tests cubren la clasificación de densidad y topología, los objetivos adaptativos, el cálculo de voxel, los veredictos de calidad y la reducción de intensidad.

Esto es deliberado: dentro de Blender no hay forma práctica de correr tests automáticos, así que la parte que toma las decisiones se mantiene fuera de `bpy`.

---

## Limitaciones conocidas

- **El bake requiere Cycles** y puede tardar bastante en mapas 4K. El addon cambia el motor temporalmente y lo restaura al terminar.
- **El cage por defecto (0.05)** está pensado para objetos de escala humana. Para un modelo muy chico o muy grande hay que ajustarlo, o el bake sale con huecos o captura geometría vecina.
- **El remesh descarta vertex groups.** En modelos riggeados hay que transferir los pesos desde el original (Data Transfer).
- **Smart UV Project** genera UVs utilizables para bakear, pero para texturas pintadas a mano conviene desplegar a mano.
- Escrito contra la API de Blender 3.6–4.x. El código contempla los cambios de 4.1 (`use_auto_smooth` → `shade_smooth_by_angle`) y 4.0 (`export_scene.obj` → `wm.obj_export`).
- **No fue ejecutado dentro de Blender todavía.** Ver la nota de estado abajo.

---

## Estado de verificación

| Qué | Cómo se verificó |
|---|---|
| Lógica de decisión (`core/`) | 52 tests unitarios, todos pasan |
| Sintaxis de los 6 módulos | `py_compile`, sin errores |
| Imports y declaración de clases | Importado contra stubs de `bpy`/`bmesh`/`mathutils`: los 4 módulos cargan, 11 clases, 9 operadores |
| Llamadas reales a la API de Blender | **Pendiente** — hace falta Blender instalado |

La primera corrida en Blender conviene hacerla sobre una copia del `.blend`, con un modelo simple, y usando **ANALIZAR MODELO** antes que AUTO: ese botón no modifica nada y ya muestra si el análisis lee bien la malla.
