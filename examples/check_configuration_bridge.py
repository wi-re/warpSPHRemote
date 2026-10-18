"""Exercise the installed daemon catalogue and sparse configuration validation.

PYTHONPATH=python python examples/check_configuration_bridge.py \
  --python /path/to/warp/bin/python --output /tmp/configuration-bridge-check
The output directory must be new. No simulation is advanced or exported.
"""
import argparse
import json
from pathlib import Path
from warpsph_remote.configuration import query_solver


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    discovered=query_solver(args.python,'--catalogue',{})
    cases=discovered.get('presets',[])
    assert cases,discovered
    (args.output/'catalogue.json').write_text(json.dumps(discovered,indent=2))
    case=next(c for c in cases if c['id']=='sod2d' and c['available'])
    spec=dict(preset=case['id'],scheme='CRKSPH',nx=32,duration=.1,
              configuration=dict(params={'left_rho':1.5},solver={'diffusionParams':{'K':.7}}))
    schema=query_solver(args.python,'--describe',spec)
    assert schema.get('supported'),schema
    valid=query_solver(args.python,'--validate',spec)
    assert valid.get('valid'),valid
    spec['configuration']['params']['left_rho']=-1
    invalid=query_solver(args.python,'--validate',spec)
    assert not invalid.get('valid') and 'left_rho' in invalid.get('error',''),invalid
    (args.output/'checks.json').write_text(json.dumps(dict(valid=valid,invalid=invalid),indent=2))
    print(f'{len(cases)} installed cases; sparse Sod override accepted; negative density rejected.')


if __name__=='__main__':
    main()
