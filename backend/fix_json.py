import json

with open("readable_color_id_map.json", "r") as f:
    readable = json.load(f)

just_ids = [entry["id"] for entry in readable]

with open("id_map_color.json", "w") as f:
    json.dump(just_ids, f)