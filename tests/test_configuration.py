import pytest
from warpsph_remote.catalogue import validate_launch
from warpsph_remote.configuration import restricted_configuration
from warpsph_remote.daemon import Manager


def test_dynamic_catalogue_is_authoritative():
    entry = dict(id='installed-new-case', schemes=['solver'], variants={'default':{}}, nx=32, duration=1, available=True)
    assert validate_launch({'preset':entry['id']}, [entry])['variant'] == 'default'
    with pytest.raises(ValueError, match='Unknown'):
        validate_launch({'preset':'gresho'}, [entry])
    entry.update(available=False, unavailableReason='Needs migration')
    with pytest.raises(ValueError, match='Needs migration'):
        validate_launch({'preset':entry['id']}, [entry])


@pytest.mark.parametrize('value', [[], {'path':'/tmp/run'}, {'simulation':{'exportRoot':'/tmp'}}, {'simulation':{'device':'cuda'}}, {'solver':{'scheme':'X'}}, {'params':{'gamma':float('nan')}}])
def test_managed_configuration_cannot_override_owned_runtime(value):
    with pytest.raises(ValueError):
        restricted_configuration(value)


def test_configuration_values_stay_sparse_and_are_validated_before_process_start(tmp_path,monkeypatch):
    import warpsph_remote.daemon as module
    m=Manager(tmp_path/'runtime')
    m.catalogue=[dict(id='new',schemes=['A'],variants={'default':{}},nx=32,duration=1)]
    monkeypatch.setattr(module,'query_solver',lambda *args:dict(valid=False,error='params.gamma: expected > 1'))
    with pytest.raises(ValueError,match='gamma'):
        m.launch(dict(preset='new',configuration={'params':{'gamma':.5}}))
    assert not m.runs
    assert restricted_configuration({'solver':{'diffusionParams':{'K':.3}}}) == {'solver':{'diffusionParams':{'K':.3}}}


def test_case_discovery_is_cached_and_can_be_refreshed(tmp_path, monkeypatch):
    import warpsph_remote.daemon as module
    calls=[]
    def query(*args):
        calls.append(args)
        return {'presets':[{'id':'extra-'+str(len(calls))}]}
    monkeypatch.setattr(module,'query_solver',query)
    m=Manager(tmp_path/'runtime')
    assert m.available_cases()[0]['id']=='extra-1'
    assert m.available_cases()[0]['id']=='extra-1'
    m.configuration_cache['old']={}
    assert m.available_cases(refresh=True)[0]['id']=='extra-2'
    assert not m.configuration_cache
    assert len(calls)==2


def test_missing_solver_is_reported_as_unavailable_without_breaking_pairing(tmp_path,monkeypatch):
    import warpsph_remote.daemon as module
    monkeypatch.setattr(module,'query_solver',lambda *args:dict(error='warpSPH is not installed'))
    m=Manager(tmp_path/'runtime')
    assert all(c['available'] is False for c in m.available_cases())
    assert all('not installed' in c['unavailableReason'] for c in m.available_cases())


def test_dimension_selection_obeys_installed_case_and_per_axis_limits():
    entry = dict(id='sedov',schemes=['CRKSPH'],variants={'default':{}},nx=512,duration=1,
                 dimension=1,dimensions=[1,2,3],maxNx=16384,maxNxByDimension={'1':16384,'2':512,'3':128})
    data=dict(preset='sedov',nx=256,configuration={'simulation':{'dim':2,'integrationScheme':'rungeKutta4'}})
    assert validate_launch(data,[entry])['configuration']==data['configuration']
    with pytest.raises(ValueError,match='3D'):
        validate_launch({**data,'configuration':{'simulation':{'dim':3}}},[entry])
    for dim in (0,4,True,2.0,'2'):
        with pytest.raises(ValueError,match='dimension'):
            validate_launch({**data,'configuration':{'simulation':{'dim':dim}}},[entry])
    entry['dimensions']=[1]
    with pytest.raises(ValueError,match='dimension'):
        validate_launch(data,[entry])
    # Older catalogues remain fixed to their advertised default dimension.
    entry.pop('dimensions')
    with pytest.raises(ValueError,match='dimension'):
        validate_launch(data,[entry])


def test_classic_integrator_conflicts_fail_before_startup():
    from types import SimpleNamespace
    from warpsph_remote.configuration import validate_classic_integrator
    ctx=SimpleNamespace(schemeConfig=SimpleNamespace(compatibleEnergy=True))
    for method in ('symplecticEuler','semiImplicitEuler','leapFrog','velocityVerlet'):
        with pytest.raises(ValueError,match='stage weights'):
            validate_classic_integrator(ctx,SimpleNamespace(integrationScheme=method))
    for method in ('rungeKutta2','rungeKutta4'):
        validate_classic_integrator(ctx,SimpleNamespace(integrationScheme=method))
    ctx.schemeConfig.compatibleEnergy=False
    validate_classic_integrator(ctx,SimpleNamespace(integrationScheme='symplecticEuler'))
