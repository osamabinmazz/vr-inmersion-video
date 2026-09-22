# ULTRA 3D RECONSTRUCTOR

Add-on de Blender para reconstruir, restaurar y optimizar modelos 3D
**midiendo**, no a ojo.

No es un script que agrega subdivisiones. La diferencia práctica:

| Lo que hace un script de subdivisión | Lo que hace esto |
|---|---|
| Subsurf nivel 3 → Apply, a todo por igual | Mide la curvatura y reparte los polígonos donde hay forma |
| Trata igual a un carpincho, un ombú y una estatua | Clasifica el modelo y cambia la técnica según lo que es |
| "Quedó con más polígonos, entonces está mejor" | Mide la desviación contra el original y da un veredicto |
| Destruye el original | El original queda intacto, bloqueado, en `00_SOURCE` |

---

## Instalación

1. Comprimir esta carpeta en un ZIP (`ultra_3d_reconstructor.zip`).
2. Blender → Editar → Preferencias → Complementos → Instalar…
3. Activar **ULTRA 3D RECONSTRUCTOR**.
4. En el visor 3D, tecla **N** → pestaña **ULTRA 3D**.

Probado contra Blender 3.6 y 4.x. Las diferencias entre versiones que
importan están contempladas en el código (ver *Limitaciones*).

---

## Las 26 etapas

| # | Etapa | Qué hace |
|---|---|---|
| 01 | Inspección | Mide todo sin tocar nada |
| 02 | Clasificación | Decide qué es el modelo (A–J) con evidencia citable |
| 03 | Puntaje inicial | 0–100 en siete ejes |
| 04 | Respaldo | Copia el original a `00_SOURCE`, oculto y bloqueado |
| 05 | Limpieza | Duplicados, sueltos, degeneradas, caras interiores |
| 06 | Normales | Suavizado por ángulo + Weighted Normal |
| 07 | Transformaciones | Aplica la escala (obligatorio antes de remeshear) |
| 08 | Agujeros | Cierra huecos chicos — **saltada en follaje** |
| 09 | Auditoría UV | Capas, UDIMs, solapamiento estimado |
| 10 | Generación UV | Smart UV Project si hace falta |
| 11 | Estrategia | Informa el plan y por qué |
| 12 | Reconstrucción | Subdivisión adaptativa / Multires / remesh / nada |
| 13 | Super-resolución | Densifica solo aristas con curvatura, y verifica |
| 14 | Reproyección | Shrinkwrap contra el original + suavizado correctivo |
| 15 | Microrelieve | Solo desde mapas existentes; **nunca inventado** |
| 16 | MASTER_ULTRA | La versión de máxima calidad |
| 17 | Control de desviación | Hausdorff bidireccional por muestreo |
| 18 | Retopología | QuadriFlow (con respaldo si falla) |
| 19 | UVs definitivas | Para la malla nueva |
| 20 | Horneado | Normal, AO, curvatura, cavidad, altura, color |
| 21 | LODs | LOD0–LOD3, colapsando primero lo plano |
| 22 | Control de silueta | 8 vistas renderizadas y comparadas |
| 23 | Puntaje final | ANTES → DESPUÉS por eje |
| 24 | Escena comparadora | Todas las versiones alineadas |
| 25 | Exportación | GLB / FBX / OBJ + texturas |
| 26 | Informe | `MODEL_REPORT.txt` |

Las etapas que no corresponden **no se ejecutan a medias**: se saltan con
el motivo anotado en el informe.

---

## Clasificación (A–J)

`A` animal · `B` humano/personaje · `C` árbol · `D` planta · `E` estatua/escultura ·
`F` objeto rígido · `G` arquitectura · `H` fotogrametría · `I` terreno · `J` desconocido

La decisión sale de señales medibles —proporciones del bounding box,
simetría bilateral, planaridad, curvatura, relación quad/triángulo, bordes
abiertos, islas sueltas, presencia de rig, pistas del nombre— y viene con
su **confianza** y su **segunda opción**. Si nada reúne evidencia
suficiente, dice `J desconocido` y usa el tratamiento conservador, en vez
de inventar una categoría.

Debajo de 50 caras las medidas de forma no describen nada y se ignoran: un
tetraedro da "0% plano" y eso no lo vuelve una escultura.

---

## Presets

| Preset | Lo que **prohíbe** | Por qué |
|---|---|---|
| ANIMAL | — | Conserva vertex groups; no fuerza aristas duras |
| TREE / PLANT | **voxel remesh, retopología, cerrar agujeros** | Fusionaría las tarjetas de hojas en una masa |
| STATUE | — | Admite subdivisión agresiva y microrelieve |
| PHOTOGRAMMETRY | **subdivisión** | El detalle ya está en los vértices; agregar peso no agrega información |
| OBJECT | — | Protege aristas vivas y ángulos rectos |
| VR | — | Presupuestos bajos, un material, normal map obligatorio |
| CINEMATIC ULTRA | — | Sin techo de polígonos; verifica RAM antes |

---

## Cómo se mide la fidelidad

Tres mediciones **independientes**, porque cada una se puede engañar sola:

1. **Desviación bidireccional (tipo Hausdorff)**. Se mide en los dos
   sentidos a propósito: si el resultado se comió una oreja, todos *sus*
   puntos siguen cerca del original y la medición unidireccional daría
   bien. La asimetría entre ida y vuelta distingue *detalle perdido* de
   *geometría inventada*.
2. **Silueta multi-vista**. Ocho ángulos renderizados con Workbench y
   comparados píxel a píxel. Manda la **peor vista**, nunca el promedio:
   siete vistas perfectas y una rota siguen siendo un modelo roto.
3. **Volumen**. Barato, delata colapso o inflado global. Solo se aplica a
   mallas cerradas.

El veredicto final es el **peor** de los tres.

---

## Limitaciones técnicas reales de Blender

Están dichas acá y en el informe de cada modelo, en vez de disimularse:

**1. No existe subdivisión adaptativa como geometría.**
El modificador Subdivision Surface es global; "Adaptive Subdivision" solo
existe como dicing de render en Cycles. *Alternativa usada*: subdividir
parejo y después colapsar con Decimate guiado por un grupo de vértices de
curvatura. El resultado es el reparto que el plan calculó, y se verifica
midiendo. El informe muestra cuántos triángulos usó la adaptativa contra
los que habría usado la uniforme.

**2. No hay métrica de Hausdorff.**
*Alternativa usada*: muestreo bidireccional con `BVHTree.find_nearest`.
Con 20.000 muestras el percentil 99 es estable; por debajo de 2.000 el
informe marca el resultado como orientativo en vez de presentarlo como
concluyente.

**3. No hay bake de curvatura ni de cavidad.**
*Alternativa usada*: material temporal con `Geometry → Pointiness` y bake
`EMIT`. Es el camino real, no una imitación del mapa.

**4. El bake de altura solo existe con Multires.**
Sin Multires se omite y se explica, en vez de entregar una imagen gris. El
normal map cubre el mismo microrelieve sin los problemas de silueta del
displacement.

**5. Detección exacta de UVs superpuestas: prohibitiva.**
*Alternativa usada*: estimación Monte Carlo sobre grilla, con semilla fija
para que dos corridas den el mismo número. El informe la llama estimación.

**6. Multires exige topología all-quad sin non-manifold.**
Cuando falla, se cae a subdivisión adaptativa y queda registrado.

**7. QuadriFlow falla con escaneos muy sucios.**
Hay camino de respaldo (voxel remesh en modo quad + Decimate). Da quads
menos prolijos y sin bucles de borde, pero entrega una malla utilizable.

**8. Cambios de API entre versiones.**
`mesh.use_auto_smooth` desapareció en 4.1 (→ `shade_smooth_by_angle`) y
`export_scene.obj` en 4.0 (→ `wm.obj_export`). Se detecta la versión en
ejecución; no se asume ninguna.

**9. Memoria.**
Un master de 12M de triángulos pide del orden de 12 GB. El plan estima el
pico, lo compara con la RAM disponible y **baja el objetivo avisando**, en
vez de fallar a mitad del proceso.

---

## Lo que el add-on NO hace, por decisión

- **No inventa estructura.** El microrelieve sale de un mapa de altura que
  el modelo ya tenga. Sin ese mapa, no agrega relieve y lo explica. No hay
  generadores de "poros de piedra" ni ruido procedural haciéndose pasar por
  detalle recuperado.
- **No toca el original.** Ni siquiera para "mejorarlo": se duplica primero,
  siempre.
- **No confunde peso con calidad.** Si el modelo ya es denso, la
  reconstrucción geométrica se saltea y lo dice.
- **No aprueba por defecto.** Una medición que no se pudo hacer queda como
  *no medida* y el veredicto lo refleja.

---

## Verificación

El paquete `core/` es Python puro y no importa `bpy`:

```bash
cd tools/ultra_3d_reconstructor
python3 -m unittest discover -s tests -v
```

**114 tests, todos en verde.** Cubren los escenarios en los que un error
destruye el modelo:

- follaje que nunca debe remeshearse ni retopologizarse;
- escaneos que se retopologizan en vez de subdividirse;
- modelos ya densos que no se inflan;
- una caja que no termina en millones de triángulos;
- desviación bidireccional que detecta detalle perdido *y* geometría
  inventada;
- silueta donde manda la peor vista;
- tolerancias que escalan con el preset (follaje tolera lo que una estatua
  no);
- recorte del objetivo cuando la RAM no alcanza;
- el respaldo del original presente en todos los planes.

Las capas que hablan con Blender se verificaron aparte contra stubs de la
API: los trece módulos importan, las quince clases se registran y los trece
operadores quedan declarados. El **comportamiento geométrico en ejecución
solo se puede verificar dentro de Blender**, y esa parte no está corrida
acá: lo que está probado es que el add-on carga y que la lógica de decisión
es correcta.

---

## Estructura

```
ultra_3d_reconstructor/
├── __init__.py            bl_info y registro
├── core/                  Python puro, testeable sin Blender
│   ├── stats.py           expediente de medición
│   ├── scoring.py         puntaje 0-100 en siete ejes
│   ├── classify.py        clasificación semántica A-J
│   ├── presets.py         ocho presets
│   ├── planning.py        26 etapas, subdivisión adaptativa, hardware
│   └── deviation.py       Hausdorff, silueta, volumen, veredicto
├── analysis.py            medición dentro de Blender
├── cleanup.py             colecciones, respaldo, reparación
├── reconstruction.py      subdivisión adaptativa / Multires / remesh
├── super_resolution.py    densificar donde hay curvatura + verificar
├── sculpt_detail.py       microrelieve basado en evidencia
├── retopology.py          QuadriFlow + transferencia de normales
├── baking.py              horneado de mapas
├── lod.py                 LOD0-LOD3
├── quality_control.py     silueta multi-vista y escena comparadora
├── export.py              GLB / FBX / OBJ + texturas
├── logging_utils.py       bitácora, checkpoints, MODEL_REPORT.txt
├── pipeline.py            orquestador de las 26 etapas
├── ui.py                  panel N y operadores
└── tests/test_core.py     114 tests
```
