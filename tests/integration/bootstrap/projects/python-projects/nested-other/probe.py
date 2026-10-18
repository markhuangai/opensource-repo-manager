import os
import sys
import packaging
assert packaging.__version__ == '25.0'
assert sys.prefix == os.environ['VIRTUAL_ENV']
