import os
import re


def get_user(dir_loc):
    user = ""
    user_regex = r'^[a-z]+-[a-z]$'
    try:
        # h20 public
        if '/h20/Public/' in dir_loc:
            user = dir_loc.replace('/h20/Public/', '').split('/')[0]
        # h20 acquire
        elif '/h20/Acquire/MesoSPIM/' in dir_loc:
            user = dir_loc.replace('/h20/Acquire/MesoSPIM/', '').split('/')[0]
        elif '/h20/Acquire/RSCM/' in dir_loc:
            user = dir_loc.replace('/h20/Acquire/RSCM/', '').split('/')[0]
        # FastStore
        elif '/CBI_FastStore/Acquire/MesoSPIM/' in dir_loc:
            user = dir_loc.replace('/CBI_FastStore/Acquire/MesoSPIM/', '').split('/')[0]
        elif '/CBI_FastStore/Acquire/RSCM/' in dir_loc:
            user = dir_loc.replace('/CBI_FastStore/Acquire/RSCM/', '').split('/')[0]
        matches_regex = len(re.findall(user_regex, user))
        if not matches_regex:
            user = ""
    except:
        pass
    return user