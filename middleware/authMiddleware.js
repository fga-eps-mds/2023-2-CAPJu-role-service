import 'dotenv/config';
import jwt from 'jsonwebtoken';
import UserEndpointAccessLogModel from '../src/models/userEndpointAccessLog.js';
import routesPermissions from '../src/routes/routesPermissions.js';
import services from '../src/services/_index.js';

const publicEndpoints = [
  { pattern: /^\/(\?.*)?$/, method: 'GET' } // Routes '/' and '/?something' are public
];

async function authenticate(req, res, next) {

  const isPublicEndpoint = publicEndpoints.some(endpoint => endpoint.pattern.test(req.originalUrl) && endpoint.method === req.method);

  let isAccepted = true;
  let message = null;

  if(isPublicEndpoint) {
    await registerEndpointLogEvent({ req, isAccepted, message });
    next();
    return;
  }

  if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer')) {
    isAccepted = false;
    message = 'Nenhum token fornecido!';
  } else {
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decodedUser = jwt.verify(token, process.env.JWT_SECRET).id;

      const userData = await services.userService.findUserWithRole(decodedUser.cpf, ['accepted'])

      if (!userData || userData.accepted === false) {
        isAccepted = false;
        message = 'Autenticação falhou!';
      } else {
        ({ isAccepted, message } = checkPermissions({ req, isAccepted, message, userData }));
      }
    } catch (error) {
      console.log(error)
      isAccepted = false;
      message = error.name === 'TokenExpiredError' ? 'O token expirou!' : 'Autenticação falhou!';
    }
  }

  await registerEndpointLogEvent({ req, isAccepted, message });

  if (!isAccepted) {
    return res.status(401).json({ message });
  }

  next();
}

function getRequiredPermissions(req) {
  const requestPath = req.path;
  let matchingPermissions = null;
  let wasFound = false;
  for (let parentRoute of routesPermissions) {
    if(wasFound)
      break;
    for (const childRoute of parentRoute.childRoutes) {
      const fullPath = parentRoute.parentPath + (childRoute.path === '' ? '' : childRoute.path);
      const regexPath = fullPath.replace(/\/:[^\/]+/g, '/[^/]+');
      const regex = new RegExp(`^${regexPath}$`);
      if (regex.test(requestPath) && childRoute?.method === req.method) {
        matchingPermissions = childRoute.permissions;
        wasFound = true;
        break;
      }
    }
  }
  return matchingPermissions;
}

function checkPermissions({ req, isAccepted, message, userData }) {
  let requiredPermissions = getRequiredPermissions(req);
  if(requiredPermissions) {
    requiredPermissions = Array.isArray(requiredPermissions) ? requiredPermissions : [requiredPermissions];
    if (!requiredPermissions.every(p => userData.role.allowedActions.includes(p))) {
      isAccepted = false;
      message = 'Permissão negada!';
    }
  }
  return { isAccepted, message };
}

async function userFromReq(req) {
  const token = req.headers.authorization.split(' ')[1];
  return jwt.decode(token).id;
}

async function registerEndpointLogEvent({ req, isAccepted, message }) {
  let userCPF;
  try {
    userCPF = (await userFromReq(req)).cpf;
  } catch (e) { userCPF = null; }
  try {
    await UserEndpointAccessLogModel.create({
      endpoint: req.originalUrl,
      httpVerb: req.method,
      attemptTimestamp: new Date(),
      userCPF,
      isAccepted,
      message,
      service: 'Role',
    });
  } catch (error) {
    console.error('Error logging request: ', error);
  }
}

export {
  authenticate,
  userFromReq,
};