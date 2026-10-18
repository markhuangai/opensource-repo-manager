import os
import sys
import packaging
assert packaging.__version__ == '24.2'
assert sys.prefix == os.environ['VIRTUAL_ENV']
