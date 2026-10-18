import os
import pathlib
import sys
import packaging
assert os.getuid() != 0
assert packaging.__version__ == '24.2'
assert sys.prefix == os.environ['VIRTUAL_ENV']
pathlib.Path('.tests-ran').write_text('passed')
