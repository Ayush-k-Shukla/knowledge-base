import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { Model } from 'mongoose';
import { User, UserDocument } from '../user/schemas/user.schema';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private jwtService: JwtService,
  ) {}

  async register(email: string, pass: string) {
    this.logger.log(`[Auth] Register attempt for email=${email}`);
    const existing = await this.userModel.findOne({ email });
    if (existing) {
      this.logger.warn(
        `[Auth] Registration failed because email already exists: ${email}`,
      );
      throw new ConflictException('Email already exists');
    }
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(pass, salt);

    const newUser = await new this.userModel({ email, passwordHash }).save();
    this.logger.debug(
      `[Auth] Registered user id=${newUser._id} email=${email}`,
    );
    return this.login(newUser);
  }

  async validateUser(email: string, pass: string): Promise<any> {
    this.logger.debug(`[Auth] Validating user for email=${email}`);
    const user = await this.userModel.findOne({ email });
    if (user && (await bcrypt.compare(pass, user.passwordHash))) {
      this.logger.debug(`[Auth] User validation successful for email=${email}`);
      const { passwordHash, ...result } = user.toObject();
      void passwordHash;
      return result;
    }
    this.logger.warn(`[Auth] User validation failed for email=${email}`);
    return null;
  }

  async login(user: any) {
    const payload = {
      email: user.email,
      sub: user._id?.toString() || user.id?.toString(),
    };
    this.logger.log(`[Auth] Generating JWT for user id=${payload.sub}`);
    return {
      access_token: this.jwtService.sign(payload),
      email: user.email,
    };
  }
}
