import json
import os


def get_input_from_data(pth):
    print('get_input_from_data')
    dataset_info_path = os.path.join(os.path.dirname(pth), '.dataset_info.json')
    try:
        with open(dataset_info_path, 'r') as f:
            data = json.load(f)
        return data['base_input_dir']
    except:
        return ''


def get_output_from_data(pth):
    dataset_info_path = os.path.join(pth, '.dataset_info.json')
    try:
        with open(dataset_info_path, 'r') as f:
            data = json.load(f)
        return data['base_output_dir']
    except:
        return ''
