import os
import pathlib
import packaging
assert os.getuid() != 0
assert packaging.__version__ == '25.0'
pathlib.Path('.tests-ran').write_text('passed')
