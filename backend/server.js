// Atlas extension preloader registers additive intelligence routes and storage
// before the existing server implementation starts listening.
require('./AtlasExtensions');
require('./server_impl');
