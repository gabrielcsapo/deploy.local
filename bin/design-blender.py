# `deploy design check` and `deploy design export` for a model board: builds one model in Blender
# and writes what the board shows and the check reads.
#
#   python3 design-blender.py -- --model design/models/Crate.py --out DIR --box 1x1x1 \
#     --palette '{"ink":"#1d1b26",...}' [--size 576] [--samples 16]
#   blender -b --factory-startup --python design-blender.py -- (the same)
#
# A model is a Python script that builds it with bpy (with pal() and part() to hand), or a .glb,
# .gltf or .blend file. DIR gets model.glb, a picture from the front, side, three-quarter and top
# (orthographic, on a transparent ground, framed on the declared box and any part past it) and
# stats.json: triangles, bounds, colours, and where each picture's model and box fall.
#
# The box is where the model must fit, in metres: width (x) by depth (y) by height (z), standing
# on the ground at the origin. Blender is z-up; the .glb is y-up, as glTF wants.

import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Matrix, Vector

VIEWS = ['front', 'side', 'three-quarter', 'top']


def arguments():
    argv = sys.argv[sys.argv.index('--') + 1 :] if '--' in sys.argv else sys.argv[1:]
    found = {'size': '576', 'samples': '16', 'palette': '{}'}
    key = None
    for word in argv:
        if word.startswith('--'):
            key = word[2:]
            found[key] = 'true'
        elif key:
            found[key] = word
            key = None
    return found


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def hex_rgb(value):
    value = value.strip().lstrip('#')
    if len(value) == 3:
        value = ''.join(ch * 2 for ch in value)
    return tuple(int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))


def rgb_hex(rgb):
    return '#' + ''.join(f'{round(max(0, min(1, c)) * 255):02x}' for c in rgb)


def make_helpers(palette):
    """What a model script has to hand besides bpy: pal('blue') and part(...)."""
    materials = {}

    def pal(name):
        if name not in palette:
            raise KeyError(f'"{name}" is not in the palette ({", ".join(sorted(palette))})')
        if name not in materials:
            material = bpy.data.materials.new(f'pal-{name}')
            material.use_nodes = True
            rgb = hex_rgb(palette[name])
            linear = [srgb_to_linear(c) for c in rgb]
            principled = material.node_tree.nodes.get('Principled BSDF')
            if principled:
                principled.inputs['Base Color'].default_value = (*linear, 1)
                principled.inputs['Roughness'].default_value = 0.85
            material.diffuse_color = (*linear, 1)
            materials[name] = material
        return materials[name]

    def part(kind, name, size, at=(0, 0, 0), colour=None, rotate=(0, 0, 0), bevel=0, sides=12):
        """A primitive part: size is its box in metres (x, y, z), at its centre, rotate in degrees."""
        kinds = {
            'box': lambda: bpy.ops.mesh.primitive_cube_add(size=1),
            'cylinder': lambda: bpy.ops.mesh.primitive_cylinder_add(
                vertices=sides, radius=0.5, depth=1
            ),
            'cone': lambda: bpy.ops.mesh.primitive_cone_add(vertices=sides, radius1=0.5, depth=1),
            'sphere': lambda: bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.5),
        }
        if kind not in kinds:
            raise ValueError(f'part kind "{kind}" is not one of {", ".join(kinds)}')
        if colour is None:
            raise ValueError(f'part "{name}" needs a colour from the palette: colour=\'<name>\'')
        kinds[kind]()
        obj = bpy.context.active_object
        obj.name = name
        obj.scale = size
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.rotation_euler = [math.radians(a) for a in rotate]
        obj.location = at
        obj.data.materials.append(pal(colour))
        if bevel:
            modifier = obj.modifiers.new('bevel', 'BEVEL')
            modifier.width = bevel
            modifier.segments = 1
            modifier.limit_method = 'ANGLE'
        return obj

    def finish(obj, name, colour, at, rotate):
        obj.name = name
        obj.rotation_euler = [math.radians(a) for a in rotate]
        obj.location = at
        obj.data.materials.append(pal(colour))
        bpy.context.scene.collection.objects.link(obj)
        return obj

    def lathe(name, profile, at=(0, 0, 0), colour=None, sides=16, rotate=(0, 0, 0)):
        """A part turned round its own up axis (z): profile is [(radius, z), ...] from bottom to top,
        in metres. A radius of 0 closes that end. A dish, a barrel, a cone roof, a pot, a lamp shade."""
        if colour is None:
            raise ValueError(f'lathe "{name}" needs a colour from the palette: colour=\'<name>\'')
        if len(profile) < 2:
            raise ValueError(f'lathe "{name}" needs at least two (radius, z) points')
        verts, faces, rings = [], [], []
        for radius, z in profile:
            if radius <= 1e-6:
                rings.append([len(verts)])
                verts.append((0, 0, z))
                continue
            ring = []
            for i in range(sides):
                angle = 2 * math.pi * i / sides
                ring.append(len(verts))
                verts.append((radius * math.cos(angle), radius * math.sin(angle), z))
            rings.append(ring)
        for low, high in zip(rings, rings[1:]):
            if len(low) == 1 and len(high) == 1:
                continue
            for i in range(sides):
                j = (i + 1) % sides
                if len(low) == 1:
                    faces.append((low[0], high[i], high[j])[::-1])
                elif len(high) == 1:
                    faces.append((low[i], low[j], high[0]))
                else:
                    faces.append((low[i], low[j], high[j], high[i]))
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        return finish(bpy.data.objects.new(name, mesh), name, colour, at, rotate)

    def beam(name, start, end, width, colour=None, depth=None, sides=0):
        """A bar from one point to another, in metres: a leg, a strut, a ladder rail, a cable.
        width (and depth, default width) is its cross-section; sides=0 is square, 6 or more round."""
        if colour is None:
            raise ValueError(f'beam "{name}" needs a colour from the palette: colour=\'<name>\'')
        a, b = Vector(start), Vector(end)
        length = (b - a).length
        if length < 1e-6:
            raise ValueError(f'beam "{name}" starts and ends at the same point')
        if sides:
            bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=0.5, depth=1)
        else:
            bpy.ops.mesh.primitive_cube_add(size=1)
        obj = bpy.context.active_object
        obj.name = name
        obj.scale = (width, depth or width, length)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.rotation_mode = 'QUATERNION'
        obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference((b - a).normalized())
        obj.location = (a + b) / 2
        obj.data.materials.append(pal(colour))
        return obj

    return pal, part, lathe, beam


def load_model(path, palette):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = os.path.splitext(path)[1].lower()
    if ext == '.py':
        pal, part, lathe, beam = make_helpers(palette)
        with open(path, encoding='utf8') as handle:
            code = compile(handle.read(), path, 'exec')
        exec(code, {'__name__': '__model__', 'bpy': bpy, 'pal': pal, 'part': part, 'lathe': lathe,
                    'beam': beam, 'math': math, 'Vector': Vector, 'Matrix': Matrix})
    elif ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.blend':
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, use_scripts=False)
    else:
        raise ValueError(f'a model is a .py, .glb, .gltf or .blend file, not {ext}')
    for obj in list(bpy.context.scene.objects):
        if obj.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(obj)


def measured():
    """Triangles after modifiers, world bounds, and the colours its faces are drawn in."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    tris = 0
    low = Vector((math.inf,) * 3)
    high = Vector((-math.inf,) * 3)
    colours = {}
    uncoloured = 0
    objects = 0
    parts = []
    for obj in bpy.context.scene.objects:
        if obj.type not in ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT') or obj.hide_render:
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        if mesh is None:
            continue
        objects += 1
        mesh.calc_loop_triangles()
        tris += len(mesh.loop_triangles)
        matrix = evaluated.matrix_world
        part_low = Vector((math.inf,) * 3)
        part_high = Vector((-math.inf,) * 3)
        for vertex in mesh.vertices:
            point = matrix @ vertex.co
            part_low = Vector(map(min, part_low, point))
            part_high = Vector(map(max, part_high, point))
        if part_low.x != math.inf:
            low = Vector(map(min, low, part_low))
            high = Vector(map(max, high, part_high))
            parts.append({'name': obj.name, 'min': list(part_low), 'max': list(part_high)})
        slots = evaluated.material_slots
        for triangle in mesh.loop_triangles:
            index = triangle.material_index
            material = slots[index].material if index < len(slots) else None
            if material is None:
                uncoloured += 1
                continue
            colour = material_colour(material)
            entry = colours.setdefault(colour, {'colour': colour, 'material': material.name, 'tris': 0})
            entry['tris'] += 1
        evaluated.to_mesh_clear()
    if not objects or low.x == math.inf:
        low = high = Vector((0, 0, 0))
    return {
        'tris': tris,
        'objects': objects,
        'bounds': {'min': list(low), 'max': list(high)},
        'colours': sorted(colours.values(), key=lambda entry: -entry['tris']),
        'uncoloured': uncoloured,
        'parts': parts[:400],
    }


def material_colour(material):
    rgb = material.diffuse_color[:3]
    if material.use_nodes and material.node_tree:
        for node in material.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                rgb = node.inputs['Base Color'].default_value[:3]
                break
    return rgb_hex([linear_to_srgb(c) for c in rgb])


def box_corners(box):
    w, d, h = box
    return [Vector((x, y, z)) for x in (-w / 2, w / 2) for y in (-d / 2, d / 2) for z in (0, h)]


def view_direction(view):
    """From where each camera looks at the box (Blender is z-up; the front faces -y)."""
    return {
        'front': Vector((0, -1, 0)),
        'side': Vector((1, 0, 0)),
        'three-quarter': Vector((1, -1, 0.82)).normalized(),
        'top': Vector((0, 0, 1)),
    }[view]


def setup_scene(size, samples):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 2
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    # Standard, not Filmic or AgX: a palette colour should read as the colour it is.
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    world = bpy.data.worlds.new('ground light') if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get('Background')
    if background:
        background.inputs['Color'].default_value = (1, 1, 1, 1)
        background.inputs['Strength'].default_value = 0.55
    sun = bpy.data.lights.new('key', 'SUN')
    sun.energy = 2.6
    sun.angle = math.radians(8)
    key = bpy.data.objects.new('key', sun)
    scene.collection.objects.link(key)
    key.rotation_euler = (math.radians(50), math.radians(-12), math.radians(-35))
    camera_data = bpy.data.cameras.new('view')
    camera_data.type = 'ORTHO'
    camera = bpy.data.objects.new('view', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    return scene, camera


def aim(camera, view, box, bounds):
    """
    The camera framed on the box and the model together, square to the view: a model that keeps
    to its box is framed the same way every time, and a part past the box is still in the picture.
    """
    points = box_corners(box)
    if bounds:
        low, high = Vector(bounds['min']), Vector(bounds['max'])
        points += [Vector((x, y, z)) for x in (low.x, high.x) for y in (low.y, high.y) for z in (low.z, high.z)]
    low = Vector(map(min, *points)) if len(points) > 1 else points[0]
    high = Vector(map(max, *points)) if len(points) > 1 else points[0]
    centre = (low + high) / 2
    toward = view_direction(view)
    up = Vector((0, 1, 0)) if view == 'top' else Vector((0, 0, 1))
    # The picture's right is x, its up is y, and the camera looks down -z (toward the model).
    right = up.cross(toward).normalized()
    upward = toward.cross(right).normalized()
    rotation = Matrix((right, upward, toward)).transposed()
    reach = 4 * max((high - low).length, 1) + 1
    camera.matrix_world = Matrix.Translation(centre + toward * reach) @ rotation.to_4x4()
    bpy.context.view_layer.update()
    inverse = camera.matrix_world.inverted()
    local = [inverse @ point for point in points]
    left, right_edge = min(p.x for p in local), max(p.x for p in local)
    bottom, top = min(p.y for p in local), max(p.y for p in local)
    camera.location = camera.location + right * ((left + right_edge) / 2) + upward * ((bottom + top) / 2)
    camera.data.ortho_scale = max(right_edge - left, top - bottom) * 1.2
    camera.data.clip_start = 0.01
    camera.data.clip_end = reach * 3
    bpy.context.view_layer.update()


def project(scene, camera, point):
    from bpy_extras.object_utils import world_to_camera_view

    at = world_to_camera_view(scene, camera, point)
    return [round(at.x, 4), round(1 - at.y, 4)]


def read_picture(path):
    """Where the model is in a picture: its bounds (as fractions), and whether it meets an edge."""
    image = bpy.data.images.load(path)
    width, height = image.size
    import numpy

    pixels = numpy.array(image.pixels[:], dtype=numpy.float32).reshape(height, width, 4)
    bpy.data.images.remove(image)
    solid = pixels[:, :, 3] > 0.5
    if not solid.any():
        return {'drawn': 0, 'bounds': None, 'edges': []}
    rows = numpy.where(solid.any(axis=1))[0]
    cols = numpy.where(solid.any(axis=0))[0]
    # Blender's rows run bottom to top.
    top, bottom = height - 1 - rows.max(), height - 1 - rows.min()
    edges = []
    if solid[-1, :].any():
        edges.append('top')
    if solid[0, :].any():
        edges.append('bottom')
    if solid[:, 0].any():
        edges.append('left')
    if solid[:, -1].any():
        edges.append('right')
    return {
        'drawn': round(float(solid.mean()), 4),
        'bounds': [
            round(cols.min() / width, 4),
            round(top / height, 4),
            round((cols.max() + 1) / width, 4),
            round((bottom + 1) / height, 4),
        ],
        'edges': edges,
    }


def main():
    args = arguments()
    out = args['out']
    os.makedirs(out, exist_ok=True)
    palette = json.loads(args['palette'])
    box = [float(n) for n in args.get('box', '1x1x1').lower().replace('×', 'x').split('x')]
    size = int(args['size'])
    samples = int(args['samples'])
    stats = {'model': os.path.basename(args['model']), 'box': box, 'views': {}}
    try:
        load_model(args['model'], palette)
    except Exception as error:  # the model's own script failed: say where, and stop
        stack = traceback.extract_tb(error.__traceback__)
        line = next((frame.lineno for frame in reversed(stack) if frame.filename == args['model']), None)
        said = error.args[0] if isinstance(error, KeyError) and error.args else error
        stats['error'] = f'{type(error).__name__}: {said}'
        stats['line'] = line
        write_stats(out, stats)
        return 2
    stats.update(measured())
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(out, 'model.glb'), export_format='GLB', export_apply=True
    )
    if args.get('no-render') == 'true':
        write_stats(out, stats)
        return 0
    scene, camera = setup_scene(size, samples)
    edges = [(a, b) for a in range(8) for b in range(a + 1, 8) if bin(a ^ b).count('1') == 1]
    for view in VIEWS:
        aim(camera, view, box, stats.get('bounds'))
        path = os.path.join(out, f'{view}.png')
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        picture = read_picture(path)
        picture['box'] = [project(scene, camera, corner) for corner in box_corners(box)]
        picture['boxEdges'] = edges
        stats['views'][view] = picture
    write_stats(out, stats)
    return 0


def write_stats(out, stats):
    with open(os.path.join(out, 'stats.json'), 'w', encoding='utf8') as handle:
        json.dump(stats, handle, indent=2)


if __name__ == '__main__':
    code = main()
    sys.stdout.flush()
    os._exit(code)
